// nap.task.mjs: a task that only waits (tests fill the helper's slots and its waiting line with it).
export default ({ ms }) => new Promise((resolve) => setTimeout(() => resolve("rested"), ms))
