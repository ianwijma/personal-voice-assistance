// wait.task.mjs: a task that only waits, so a test can fill the off-thread helper's two slots and its 32-call queue.
export default ({ ms }) => new Promise((resolve) => setTimeout(() => resolve("waited"), ms))
