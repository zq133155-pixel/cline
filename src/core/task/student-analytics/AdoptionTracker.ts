/**
 * AI 建议采纳推断器
 * Adoption Tracker - Infers whether students adopted AI suggestions
 *
 * 推断规则（弱判断版本 v1）：
 * 1. AI 回复后 60s 内有代码编辑/文件保存 → adopted
 * 2. AI 回复后用户继续追问同一主题 → continued
 * 3. AI 回复后用户追问不同主题或开启新任务 → rejected
 * 4. 超时或无后续行为 → unknown
 */

import type { AdoptionStatus, SuggestionType } from "./types"

/**
 * 缓存的 assistant turn 状态
 */
interface PendingAssistantTurn {
	/** 日志时间戳 */
	ts: string
	/** 任务 ID */
	taskId: string
	/** 轮次索引 */
	turnIndex: number
	/** AI 建议类型 */
	suggestionType: SuggestionType
	/** 是否包含代码 */
	hasCode: boolean
	/** 是否已有代码编辑行为 */
	hasCodeEdit: boolean
	/** 是否已有文件保存行为 */
	hasFileSave: boolean
	/** 创建时间（用于超时判断） */
	createdAt: number
}

/** 采纳判断的超时时间（毫秒）：60 秒 */
const ADOPTION_TIMEOUT_MS = 60_000

export class AdoptionTracker {
	/** 每个任务最近一条待判断的 assistant turn */
	private pendingTurns: Map<string, PendingAssistantTurn> = new Map()

	/**
	 * 注册一个新的 assistant turn，等待后续行为来推断采纳情况
	 */
	public registerAssistantTurn(
		taskId: string,
		turnIndex: number,
		suggestionType: SuggestionType,
		hasCode: boolean,
		ts: string,
	): void {
		// 先结算上一条待判断的 turn
		this.finalizeIfPending(taskId)

		this.pendingTurns.set(taskId, {
			ts,
			taskId,
			turnIndex,
			suggestionType,
			hasCode,
			hasCodeEdit: false,
			hasFileSave: false,
			createdAt: Date.now(),
		})
	}

	/**
	 * 当检测到代码编辑事件时调用
	 */
	public onCodeEdit(taskId: string): void {
		const pending = this.pendingTurns.get(taskId)
		if (pending) {
			pending.hasCodeEdit = true
		}
	}

	/**
	 * 当检测到文件保存事件时调用
	 */
	public onFileSave(taskId: string): void {
		const pending = this.pendingTurns.get(taskId)
		if (pending) {
			pending.hasFileSave = true
		}
	}

	/**
	 * 当用户发送新消息时，推断上一条 assistant turn 的采纳状态
	 * @param taskId 任务 ID
	 * @param isSameTopic 是否是同一主题的追问
	 * @returns 推断的采纳状态
	 */
	public onUserMessage(taskId: string, isSameTopic: boolean): AdoptionStatus {
		const pending = this.pendingTurns.get(taskId)
		if (!pending) {
			return "unknown"
		}

		const status = this.inferAdoption(pending, isSameTopic)
		this.pendingTurns.delete(taskId)
		return status
	}

	/**
	 * 最终结算某任务的待判断 turn（任务结束或新 turn 到来时调用）
	 */
	public finalizeIfPending(taskId: string): AdoptionStatus {
		const pending = this.pendingTurns.get(taskId)
		if (!pending) {
			return "unknown"
		}

		const status = this.inferAdoptionByBehavior(pending)
		this.pendingTurns.delete(taskId)
		return status
	}

	/**
	 * 获取某任务当前的待判断状态（用于调试）
	 */
	public getPendingTurn(taskId: string): PendingAssistantTurn | undefined {
		return this.pendingTurns.get(taskId)
	}

	/**
	 * 核心推断逻辑：结合用户后续消息和行为来判断
	 */
	private inferAdoption(pending: PendingAssistantTurn, isSameTopic: boolean): AdoptionStatus {
		// 规则 1：AI 建议包含代码，且用户在建议后编辑/保存了代码 → adopted
		if (pending.hasCode && (pending.hasCodeEdit || pending.hasFileSave)) {
			return "adopted"
		}

		// 规则 2：AI 建议是 completion（attempt_completion），且用户没有继续追问 → adopted
		if (pending.suggestionType === "completion") {
			return "adopted"
		}

		// 规则 3：用户继续同一主题追问 → continued
		if (isSameTopic) {
			return "continued"
		}

		// 规则 4：用户换了话题但没有编辑行为 → rejected
		if (!pending.hasCodeEdit && !pending.hasFileSave) {
			return "rejected"
		}

		// 兜底：有编辑但换了话题 → adopted（大概率参考了 AI 建议后去做别的）
		return "adopted"
	}

	/**
	 * 仅基于行为推断（没有用户后续消息时使用）
	 */
	private inferAdoptionByBehavior(pending: PendingAssistantTurn): AdoptionStatus {
		const elapsed = Date.now() - pending.createdAt

		// 有代码编辑或保存行为 → adopted
		if (pending.hasCodeEdit || pending.hasFileSave) {
			return "adopted"
		}

		// 超时且无行为 → unknown
		if (elapsed > ADOPTION_TIMEOUT_MS) {
			return "unknown"
		}

		return "unknown"
	}

	/**
	 * 推断"是否同一主题"的简单逻辑
	 * 基于上一条 assistant 的 category 和当前用户消息的 category 是否相同
	 */
	public static isSameTopicHeuristic(prevCategory: string | undefined, currentCategory: string | undefined): boolean {
		if (!prevCategory || !currentCategory) {
			return false
		}
		return prevCategory === currentCategory
	}

	/**
	 * 清理所有待判断状态
	 */
	public clear(): void {
		this.pendingTurns.clear()
	}
}
