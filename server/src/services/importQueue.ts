import type Database from "better-sqlite3";
import PQueue from "p-queue";
import { IMPORT_QUEUE_CONCURRENCY } from "../config.js";
import { runImportJob } from "./importPipeline.js";

export type QueuedImportFiles = { diskPath: string; originalname: string }[];

/** Сериализация тяжёлого импорта: один активный runImportJob на соединение (temp-таблицы, транзакции). */
let importChain: Promise<unknown> = Promise.resolve();

function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = importChain.then(() => fn());
  importChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export function createImportJobQueue(db: Database.Database) {
  const queue = new PQueue({ concurrency: IMPORT_QUEUE_CONCURRENCY });

  return {
    enqueue(
      jobId: string,
      files: QueuedImportFiles,
      opts: { force?: boolean; enqueuedAt?: number } = {}
    ) {
      const enqueuedAt = opts.enqueuedAt ?? Date.now();
      return queue.add(() =>
        runSerialized(() =>
          runImportJob(db, jobId, files, {
            force: opts.force,
            enqueuedAt,
          })
        )
      );
    },
    get waiting(): number {
      return queue.size;
    },
    get active(): number {
      return queue.pending;
    },
  };
}
