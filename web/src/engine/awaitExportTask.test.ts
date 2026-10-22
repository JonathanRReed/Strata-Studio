import { expect, test } from "bun:test";
import { awaitExportTask } from "./export.ts";

test("an already cancelled caller still handles a late task rejection", async () => {
  const controller = new AbortController();
  controller.abort();
  let rejectTask!: (error: Error) => void;
  const task = new Promise<void>((_, reject) => {
    rejectTask = reject;
  });
  await expect(awaitExportTask(task, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  rejectTask(new Error("late failure"));
  await Promise.resolve();
});
test("a pending native operation can be cancelled without its stop callback", async () => {
  const controller = new AbortController();
  const waiting = awaitExportTask(
    new Promise<void>(() => {}),
    controller.signal,
  );
  queueMicrotask(() => controller.abort());
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
});
test("a missing native callback has a bounded deadline", async () => {
  await expect(
    awaitExportTask(new Promise<void>(() => {}), undefined, 5),
  ).rejects.toMatchObject({ name: "TimeoutError" });
});
test("successful and failed tasks preserve their result", async () => {
  expect(await awaitExportTask(Promise.resolve(42), undefined, 100)).toBe(42);
  await expect(
    awaitExportTask(Promise.reject(new Error("encoder failed"))),
  ).rejects.toThrow("encoder failed");
});
