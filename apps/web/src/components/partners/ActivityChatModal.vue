<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Send, User, Users } from '@lucide/vue'
import BaseModal from '@/components/ui/BaseModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import DemoTag from '@/components/ui/DemoTag.vue'

export interface ChatMessage {
  id: string
  senderId: string
  senderName: string
  content: string
  timestamp: number
  isMe: boolean
}

const props = withDefaults(
  defineProps<{
    open: boolean
    activityId: string | null
    activityTitle: string
    real?: boolean
    currentUserName?: string
    /** 真实模式：活动已报名人数（含主办人） */
    participantCount?: number
    /** 真实模式：主办人昵称 */
    hostName?: string
  }>(),
  { real: false, currentUserName: '我', participantCount: 0, hostName: '' }
)

const emit = defineEmits<{ close: [] }>()

// 每个活动的聊天记录（本地存储，不持久化）
const chatStore = ref<Record<string, ChatMessage[]>>({})

// 当前活动的消息列表
const messages = computed(() => {
  if (!props.activityId) return []
  return chatStore.value[props.activityId] ?? []
})

// 新消息输入
const newMessage = ref('')

// 模拟的其他参与者
const DEMO_PARTICIPANTS = [
  { id: 'demo-alice', name: '小明' },
  { id: 'demo-bob', name: '小红' },
  { id: 'demo-carol', name: '活动发起人' }
]

// 模拟的初始消息
const DEMO_INITIAL_MESSAGES: Omit<ChatMessage, 'id' | 'timestamp'>[] = [
  { senderId: 'demo-carol', senderName: '活动发起人', content: '欢迎大家报名参加这次活动！', isMe: false },
  { senderId: 'demo-alice', senderName: '小明', content: '请问集合地点具体在哪里？', isMe: false },
  { senderId: 'demo-carol', senderName: '活动发起人', content: '在学校南门旁边的星巴克门口，我到时候会举个牌子', isMe: false },
  { senderId: 'demo-bob', senderName: '小红', content: '好的，我会准时到的！', isMe: false }
]

// 初始化当前活动的聊天（如果是第一次进入）
watch(
  () => props.activityId,
  (activityId) => {
    if (activityId && !chatStore.value[activityId]) {
      // 真实模式：不加载演示消息，只显示空状态
      if (props.real) {
        chatStore.value[activityId] = []
        return
      }
      // 演示模式：加载演示消息
      const now = Date.now()
      chatStore.value[activityId] = DEMO_INITIAL_MESSAGES.map((msg, index) => ({
        ...msg,
        id: `demo-${activityId}-${index}`,
        timestamp: now - (DEMO_INITIAL_MESSAGES.length - index) * 60000
      }))
    }
  },
  { immediate: true }
)

// 发送消息
function sendMessage(): void {
  const content = newMessage.value.trim()
  if (!content || !props.activityId) return

  const message: ChatMessage = {
    id: `msg-${Date.now()}`,
    senderId: 'me',
    senderName: props.currentUserName,
    content,
    timestamp: Date.now(),
    isMe: true
  }

  if (!chatStore.value[props.activityId]) {
    chatStore.value[props.activityId] = []
  }
  chatStore.value[props.activityId].push(message)
  newMessage.value = ''

  // 滚动到底部
  nextTick(() => {
    const container = document.querySelector('[data-testid="chat-messages"]')
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  })
}

// 格式化时间
function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  return `${hours}:${minutes}`
}

// 处理回车发送
function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendMessage()
  }
}

// 参与者数量
const participantCount = computed(() => {
  if (props.real) {
    return Math.max(1, props.participantCount)
  }
  return DEMO_PARTICIPANTS.length + 1
})
</script>

<template>
  <BaseModal
    :open="open"
    :title="activityTitle ? `${activityTitle} - 聊天` : '活动聊天'"
    :description="real ? '聊天功能开发中，消息仅保存在本机浏览器' : '演示模式：消息只保存在本机浏览器'"
    close-label="关闭"
    @close="emit('close')"
  >
    <div class="flex h-[60vh] flex-col">
      <!-- 参与者信息 -->
      <div class="flex items-center gap-2 border-b border-line/70 pb-3">
        <Users :size="14" class="text-ink-400" />
        <span class="text-caption text-ink-500">{{ participantCount }} 人参与</span>
        <DemoTag v-if="!real" class="ml-auto" text="演示聊天" />
      </div>

      <!-- 消息列表 -->
      <div
        class="flex-1 overflow-y-auto py-4"
        data-testid="chat-messages"
      >
        <div v-if="messages.length === 0" class="flex h-full items-center justify-center">
          <p class="text-body-sm text-ink-400">暂无消息，快来打个招呼吧！</p>
        </div>
        <div v-else class="space-y-3">
          <div
            v-for="msg in messages"
            :key="msg.id"
            class="flex gap-2"
            :class="msg.isMe ? 'flex-row-reverse' : 'flex-row'"
          >
            <!-- 头像 -->
            <div
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-caption font-semibold"
              :class="msg.isMe ? 'bg-brand-500 text-white' : 'bg-surface-sunken text-ink-600'"
            >
              <User v-if="msg.isMe" :size="14" />
              <span v-else>{{ msg.senderName.slice(0, 1) }}</span>
            </div>

            <!-- 消息内容 -->
            <div class="max-w-[70%]" :class="msg.isMe ? 'text-right' : 'text-left'">
              <p class="text-[11px] text-ink-400">
                {{ msg.isMe ? currentUserName : msg.senderName }} · {{ formatTime(msg.timestamp) }}
              </p>
              <div
                class="mt-1 inline-block rounded-2xl px-3 py-2 text-body-sm"
                :class="msg.isMe ? 'bg-brand-500 text-white' : 'bg-surface-sunken text-ink-700'"
              >
                {{ msg.content }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 输入框 -->
      <div class="border-t border-line/70 pt-3">
        <div class="flex items-end gap-2">
          <textarea
            v-model="newMessage"
            class="cg-input min-h-[40px] max-h-[100px] flex-1 resize-none"
            placeholder="输入消息…"
            rows="1"
            maxlength="500"
            data-testid="chat-input"
            @keydown="handleKeydown"
          />
          <BaseButton
            variant="gradient"
            size="icon"
            :disabled="!newMessage.trim()"
            data-testid="chat-send"
            @click="sendMessage"
          >
            <Send :size="16" />
          </BaseButton>
        </div>
        <p class="cg-hint mt-1">按 Enter 发送，Shift + Enter 换行</p>
      </div>
    </div>
  </BaseModal>
</template>
