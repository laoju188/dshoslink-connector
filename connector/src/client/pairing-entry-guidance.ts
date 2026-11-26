import type { EntryBlockReason } from '../pairing-entry-observation.js'
import type { PairingAddressState } from '../pairing-port-control.js'

export interface PairingEntryGateInput {
  readonly paired: boolean
  readonly clearInput: boolean
  readonly blockedReason: EntryBlockReason
  readonly error: string
  readonly canEnter: boolean
}

/** Same gate as the existing component; kept pure so tests can prove it is unchanged. */
export function pairingEntryAllowed(input: PairingEntryGateInput): boolean {
  return !input.paired && !input.clearInput && input.blockedReason === 'none'
    && input.error === '' && input.canEnter === true
}

export type PairingEntryAction = 'none' | 'check' | 'refresh_network'

export interface PairingEntryGuidance {
  readonly hint: string
  readonly action: PairingEntryAction
}

const none: PairingEntryGuidance = Object.freeze({ hint: '', action: 'none' })

/**
 * Local-only guidance next to the pairing-code field. Never claims that pairing can
 * complete without a supported local address, and never contains credentials.
 */
export function pairingEntryGuidance(input: PairingEntryGateInput & {
  readonly addressState?: PairingAddressState
}): PairingEntryGuidance {
  if (input.paired) return none
  if (input.blockedReason === 'no_network') {
    if (input.addressState === 'no_private_address') {
      return {
        hint: '暂时不能输入：电脑没有可用的局域网地址。首次配对需要电脑先连接常用 Wi-Fi 或有线网络；云配对不要求同一网络，但仍需要本地地址。',
        action: 'refresh_network',
      }
    }
    if (input.addressState === 'query_failed' || input.addressState === 'timeout') {
      return {
        hint: '暂时不能输入：未能读取电脑网络信息。请点“重新检测网络”；仍失败请发送连接反馈。',
        action: 'refresh_network',
      }
    }
    return {
      hint: '暂时不能输入：电脑暂未取得可用的局域网地址。请连接常用 Wi-Fi 或有线网络，或点“重新检测网络”。',
      action: 'refresh_network',
    }
  }
  if (input.error !== '') return { hint: `暂时不能输入：${input.error}`, action: 'check' }
  switch (input.blockedReason) {
    case 'preparing':
      return { hint: '正在读取电脑配对状态，暂不可输入。', action: 'check' }
    case 'read_failed':
      return { hint: '暂时无法读取电脑状态，输入内容已保留。请点“重新检查”。', action: 'check' }
    case 'paused':
      return { hint: '已暂停手机访问，配对码输入不可用；恢复只能在这台电脑上操作。', action: 'none' }
    case 'startup_failed':
      return { hint: '电脑配对服务尚未就绪，暂不可输入。请按页面提示处理后重试。', action: 'check' }
    case 'service_unavailable':
      return { hint: '电脑配对服务暂时不可用，请稍后重试。', action: 'check' }
    default:
      return none
  }
}
