import type { AppSettings } from "./domain";

export const MAX_WORK_THREAD_DOCUMENT_LENGTH = 2_000_000;

export const defaultAppSettings = (): AppSettings => ({
  workThreadTemplate: "## 目标\n\n这项工作要解决什么问题、实现什么结果？\n\n## 范围\n\n本次包含哪些内容、不包含哪些内容？\n\n## 完成标准\n\n怎样确认工作完成？需要哪些验证、review 或合并？\n",
  workThreadReminderDays: 3,
  workThreadStrongReminderDays: 7
});
