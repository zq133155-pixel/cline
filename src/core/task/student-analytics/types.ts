/**
 * 学生编程行为数据采集 - 类型定义
 * Student Programming Behavior Analytics - Type Definitions
 */

/**
 * 任务分类类型
 */
export type TaskCategory =
	| "algorithm" // 算法相关
	| "debugging" // 调试/报错
	| "explanation" // 解释/原理
	| "language_request" // 语言相关请求
	| "code_generation" // 代码生成
	| "refactoring" // 重构
	| "testing" // 测试相关
	| "other" // 其他

/**
 * 编程语言提示
 */
export type LanguageHint = "cpp" | "python" | "java" | "javascript" | "typescript" | "c" | "unknown"

/**
 * 日志事件类型
 */
export type LogEventType =
	| "task_start" // 新任务开始
	| "turn_message" // 用户/AI 在同一任务内发送的消息
	| "code_edit" // 学生代码编辑行为
	| "file_save" // 学生保存文件行为
	| "adoption_infer" // AI 建议采纳推断结果

/**
 * 消息角色
 */
export type MessageRole = "user" | "assistant" | "system"

/**
 * AI 建议类型（用于 assistant turn）
 */
export type SuggestionType =
	| "code_generation" // AI 生成了代码
	| "code_edit" // AI 修改了代码（replace_in_file / apply_patch）
	| "explanation" // AI 纯文本解释
	| "question" // AI 反问用户（ask_followup_question）
	| "completion" // AI 完成任务（attempt_completion）
	| "command" // AI 执行命令（execute_command）
	| "mixed" // AI 混合了多种工具
	| "other" // 其他

/**
 * AI 建议采纳状态
 */
export type AdoptionStatus =
	| "adopted" // 已采纳（在 AI 回复后有相关代码编辑或文件保存）
	| "rejected" // 未采纳（用户追问了不同问题 / 长时间无行动）
	| "continued" // 继续追问（用户在该建议基础上继续对话）
	| "unknown" // 无法判断

/**
 * 学生交互日志数据结构
 * Unified log structure for student interaction data
 */
export interface StudentInteractionLog {
	/** ISO 8601 时间戳 */
	ts: string
	/** 任务唯一标识 */
	taskId: string
	/** 事件类型 */
	eventType: LogEventType
	/** 消息角色 */
	role: MessageRole
	/** 任务分类 */
	category: TaskCategory
	/** 输入内容长度（字符数） */
	contentLength: number
	/** 是否包含代码 */
	hasCode: boolean
	/** 推断的编程语言 */
	languageHint: LanguageHint
	/** 附带图片数量 */
	imageCount: number
	/** 附带文件数量 */
	fileCount: number
	/** 对话轮次索引（当前任务内第几次交互） */
	turnIndex: number
	/** 原始输入内容（可选，用于离线分析） */
	rawContent?: string
	// ===== 2.0 新增字段 =====
	/** AI 建议类型（仅 role=assistant 时有值） */
	suggestionType?: SuggestionType
	/** AI 使用的工具列表（仅 role=assistant 时有值） */
	toolsUsed?: string[]
	/** 代码编辑涉及的文件路径（仅 eventType=code_edit/file_save 时有值） */
	filePath?: string
	/** 代码编辑变更量（字符差异，仅 eventType=code_edit 时有值） */
	changeDelta?: number
	/** AI 建议采纳推断（仅 role=assistant 时，会在后续事件中回填） */
	adoptionStatus?: AdoptionStatus
}

/**
 * 内容分析结果
 */
export interface ContentAnalysisResult {
	/** 内容长度 */
	contentLength: number
	/** 是否包含代码 */
	hasCode: boolean
	/** 推断的语言类型 */
	languageHint: LanguageHint
	/** 检测到的代码片段数量 */
	codeBlockCount: number
}

/**
 * 日志统计摘要
 */
export interface LogStatsSummary {
	/** 总任务数 */
	totalTasks: number
	/** 各分类数量分布 */
	categoryDistribution: Record<TaskCategory, number>
	/** 平均输入长度 */
	averageContentLength: number
	/** 包含代码的任务比例 */
	codeInclusionRate: number
	/** 各语言分布 */
	languageDistribution: Record<LanguageHint, number>
	/** 时间范围 */
	timeRange: {
		start: string
		end: string
	}
}
