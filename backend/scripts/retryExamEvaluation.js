#!/usr/bin/env node

require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env"),
});

const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const mongoose = require("mongoose");
const { EJSON } = require("bson");

const Exam = require("../src/models/Exam");
const Question = require("../src/models/Question");
const StudentExamAttempt = require("../src/models/StudentExamAttempt");
const StudentAnswer = require("../src/models/StudentAnswer");

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const RETRYABLE_ATTEMPT_STATUSES = new Set([
  "submitted",
  "transcribed",
  "evaluated",
]);

function usage() {
  console.error(
    "Usage: node scripts/retryExamEvaluation.js <24-character-exam-id>",
  );
}

function statusCounts(records) {
  return records.reduce((counts, record) => {
    const status = record.status || "(missing)";
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

async function askForConfirmation(examId) {
  const prompt = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await prompt.question(
      `\nBackup is complete. Type RETRY ${examId} to reset and queue this exam: `,
    );
    return answer.trim() === `RETRY ${examId}`;
  } finally {
    prompt.close();
  }
}

async function main() {
  const examIdText = process.argv[2];
  if (!examIdText || !OBJECT_ID_PATTERN.test(examIdText)) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (process.argv.length > 3) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not set. Configure backend/.env first.");
  }

  const examId = new mongoose.Types.ObjectId(examIdText);
  const examCollection = Exam.collection;
  const questionCollection = Question.collection;
  const attemptCollection = StudentExamAttempt.collection;
  const answerCollection = StudentAnswer.collection;

  let transcriptionQueue;
  let evaluationQueue;
  let redisConnection;

  try {
    await mongoose.connect(process.env.MONGO_URI);
    const database = mongoose.connection.db;

    const [exam, attempts, answers, questions] = await Promise.all([
      examCollection.findOne({ _id: examId }),
      attemptCollection.find({ examId }).toArray(),
      answerCollection.find({ examId }).toArray(),
      questionCollection.find({ examId }).toArray(),
    ]);

    if (!exam) {
      throw new Error(
        `Exam ${examIdText} was not found in database ${database.databaseName}.`,
      );
    }
    if (exam.status !== "published") {
      throw new Error(
        `Refusing to retry: exam status is '${exam.status}', not 'published'.`,
      );
    }
    if (exam.endTime && new Date(exam.endTime) > new Date()) {
      throw new Error("Refusing to retry before the exam endTime.");
    }

    const attemptIds = attempts.map((attempt) => attempt._id);
    const associatedAnswers = await answerCollection
      .find({ attemptId: { $in: attemptIds } })
      .toArray();

    // Include any legacy/malformed records linked by attemptId even if examId is absent.
    const allAnswersById = new Map();
    for (const answer of [...answers, ...associatedAnswers]) {
      allAnswersById.set(answer._id.toString(), answer);
    }
    const completeAnswers = [...allAnswersById.values()];

    const backupTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDirectory = path.resolve(
      __dirname,
      "../backups/exam-evaluation",
    );
    fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(backupDirectory, 0o700);
    } catch {
      // Windows may not support POSIX permission bits; the backup still remains local.
    }

    const backupPath = path.join(
      backupDirectory,
      `exam-${examIdText}-${backupTimestamp}.json`,
    );
    const snapshot = {
      backupFormat: "mongodb-extended-json-v2",
      createdAt: new Date().toISOString(),
      database: database.databaseName,
      examId: examIdText,
      collections: {
        exam: examCollection.collectionName,
        questions: questionCollection.collectionName,
        attempts: attemptCollection.collectionName,
        answers: answerCollection.collectionName,
      },
      counts: {
        exams: 1,
        questions: questions.length,
        attempts: attempts.length,
        answers: completeAnswers.length,
      },
      records: {
        exam,
        questions,
        attempts,
        answers: completeAnswers,
      },
    };

    const serializedBackup = EJSON.stringify(snapshot, {
      relaxed: false,
      indent: 2,
    });
    const fileDescriptor = fs.openSync(backupPath, "wx", 0o600);
    try {
      fs.writeFileSync(fileDescriptor, serializedBackup, "utf8");
      fs.fsyncSync(fileDescriptor);
    } finally {
      fs.closeSync(fileDescriptor);
    }

    // Re-read and verify the written backup before any state change or queue operation.
    const verifiedBackup = EJSON.parse(fs.readFileSync(backupPath, "utf8"));
    const verifiedCounts = verifiedBackup.counts;
    if (
      verifiedBackup.examId !== examIdText ||
      verifiedCounts.questions !== questions.length ||
      verifiedCounts.attempts !== attempts.length ||
      verifiedCounts.answers !== completeAnswers.length ||
      verifiedBackup.records.exam._id.toString() !== examIdText
    ) {
      throw new Error(
        `Backup verification failed. No database state was changed. Backup: ${backupPath}`,
      );
    }

    console.log(`\nVerified complete backup: ${backupPath}`);
    console.log(`Database: ${database.databaseName}`);
    console.log(`Exam: ${exam.title} (${examIdText})`);
    console.log(
      `Snapshot counts: 1 exam, ${questions.length} questions, ${attempts.length} attempts, ${completeAnswers.length} answers.`,
    );

    const retryableAttempts = attempts.filter((attempt) =>
      RETRYABLE_ATTEMPT_STATUSES.has(attempt.status),
    );
    const skippedAttempts = attempts.filter(
      (attempt) => !RETRYABLE_ATTEMPT_STATUSES.has(attempt.status),
    );
    const retryableIds = new Set(
      retryableAttempts.map((attempt) => attempt._id.toString()),
    );
    const retryableAnswers = completeAnswers.filter((answer) =>
      retryableIds.has(answer.attemptId?.toString()),
    );
    const questionsById = new Set(
      questions.map((question) => question._id.toString()),
    );
    const orphanQuestionAnswers = retryableAnswers.filter(
      (answer) => !questionsById.has(answer.questionId?.toString()),
    );

    console.log(`Attempt statuses: ${JSON.stringify(statusCounts(attempts))}`);
    console.log(
      `Will retry ${retryableAttempts.length} submitted/transcribed/evaluated attempts and ${retryableAnswers.length} answers.`,
    );
    if (skippedAttempts.length > 0) {
      console.log(
        `Will leave ${skippedAttempts.length} attempts unchanged because their status is not retryable (for example, in_progress or expired).`,
      );
    }
    if (orphanQuestionAnswers.length > 0) {
      const examples = orphanQuestionAnswers
        .slice(0, 5)
        .map((answer) => `${answer._id} -> ${answer.questionId}`)
        .join(", ");
      throw new Error(
        `Cannot safely retry: ${orphanQuestionAnswers.length} answers refer to Question documents not found for this exam (${examples}). Backup was saved; no changes were made.`,
      );
    }
    if (retryableAttempts.length === 0) {
      throw new Error(
        `No retryable attempts found. Backup was saved; no changes were made.`,
      );
    }

    const confirmed = await askForConfirmation(examIdText);
    if (!confirmed) {
      console.log(
        "Confirmation did not match. No database changes or jobs were made.",
      );
      return;
    }

    // Confirm Redis and both worker consumers are available before changing MongoDB.
    redisConnection = require("../src/config/redis");
    const answersTranscriptionQueue = require("../src/queues/answersTranscriptionQueue");
    const answersEvaluationQueue = require("../src/queues/answersEvaluationQueue");
    transcriptionQueue = answersTranscriptionQueue;
    evaluationQueue = answersEvaluationQueue;

    await Promise.all([
      transcriptionQueue.waitUntilReady(),
      evaluationQueue.waitUntilReady(),
    ]);
    await redisConnection.ping();
    const [transcriptionWorkers, evaluationWorkers] = await Promise.all([
      transcriptionQueue.getWorkers(),
      evaluationQueue.getWorkers(),
    ]);
    if (transcriptionWorkers.length === 0 || evaluationWorkers.length === 0) {
      throw new Error(
        `No changes were made. Active workers required: answers-transcription (${transcriptionWorkers.length} found) and answers-evaluation (${evaluationWorkers.length} found). Start both worker processes, then run the script again.`,
      );
    }

    const runId = new Date().toISOString().replace(/[^0-9A-Za-z]/g, "-");

    // Hide the old published scores, reset evaluation state, and retain answer/audio sources.
    const examUpdate = await examCollection.updateOne(
      { _id: examId },
      {
        $set: {
          resultsPublished: false,
          resultPublishedAt: null,
          evaluationStarted: true,
        },
      },
    );
    if (examUpdate.matchedCount !== 1) {
      throw new Error(
        "Exam disappeared before reset; no attempt or answer records were changed.",
      );
    }

    const attemptsUpdate = await attemptCollection.updateMany(
      {
        _id: { $in: retryableAttempts.map((attempt) => attempt._id) },
        examId,
      },
      {
        $set: { status: "submitted", totalScore: null, maxScore: null },
      },
    );
    if (attemptsUpdate.matchedCount !== retryableAttempts.length) {
      throw new Error(
        `Expected to reset ${retryableAttempts.length} attempts, but matched ${attemptsUpdate.matchedCount}. Backup is available at ${backupPath}.`,
      );
    }

    const answerBulkOps = retryableAnswers.map((answer) => {
      const hasAudio =
        Array.isArray(answer.recordingUrls) && answer.recordingUrls.length > 0;
      const set = {
        evaluationStatus: "pending",
        sttStatus: hasAudio ? "pending" : "skipped",
      };
      const unset = {
        score: "",
        maxMarks: "",
        evaluationFeedback: "",
        evaluationModel: "",
        evaluatedAt: "",
        sttError: "",
        sttTimestamp: "",
      };

      // Re-transcribe audio from its preserved R2 URL. Keep an existing transcript for
      // text-only records because no audio job can recreate it.
      if (hasAudio) unset.transcribedText = "";

      return {
        updateOne: {
          filter: { _id: answer._id, attemptId: answer.attemptId },
          update: { $set: set, $unset: unset },
        },
      };
    });
    if (answerBulkOps.length > 0)
      await answerCollection.bulkWrite(answerBulkOps);

    let queuedCount = 0;
    for (const attempt of retryableAttempts) {
      await transcriptionQueue.add(
        "transcribe-answers",
        {
          examId: examIdText,
          studentId: attempt.studentId.toString(),
          attemptId: attempt._id.toString(),
        },
        {
          jobId: `exam-${examIdText}-attempt-${attempt._id.toString()}-run-${runId}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: true,
        },
      );
      queuedCount += 1;
    }

    console.log(
      `\nQueued full transcription → evaluation for ${queuedCount} attempts. Results are unpublished until you verify scores and publish again.`,
    );
    console.log(`Backup to retain: ${backupPath}`);
  } finally {
    if (transcriptionQueue) await transcriptionQueue.close().catch(() => {});
    if (evaluationQueue) await evaluationQueue.close().catch(() => {});
    if (redisConnection) await redisConnection.quit().catch(() => {});
    await mongoose.disconnect().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`\nRetry script stopped: ${error.message}`);
  process.exitCode = 1;
});
