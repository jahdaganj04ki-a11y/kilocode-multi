// Provider/model types for model selector

export interface ProviderModel {
  id: string
  name: string
  inputPrice?: number
  outputPrice?: number
  contextLength?: number
  releaseDate?: string
  latest?: boolean
  // Actual shape returned by the server (Provider.Model)
  limit?: { context: number; input?: number; output: number }
  variants?: Record<string, Record<string, unknown>>
  capabilities?: {
    reasoning: boolean
    input?: { text: boolean; image: boolean; audio: boolean; video: boolean; pdf: boolean }
  }
  options?: { description?: string }
  autoRouting?: { models: string[] }
  recommendedIndex?: number
  isFree?: boolean
  mayTrainOnYourPrompts?: boolean
  hasUserByokAvailable?: boolean
  terminalBench?: {
    overallScore: number
    avgAttemptCostUsd: number
  }
  cost?: {
    input: number
    output: number
    cache?: {
      read: number
      write: number
    }
  }
}

export interface Provider {
  id: string
  name: string
  models: Record<string, ProviderModel>
  source?: "env" | "config" | "custom" | "api"
  env?: string[]
  metadata?: {
    noteKey?: string
    icon?: string
    priority?: number
  }
}

export interface ModelSelection {
  providerID: string
  modelID: string
}

export interface ModelUsage {
  count: number
  lastUsed: number
}

export type ModelUsageMap = Record<string, ModelUsage>

export type ProviderAuthState = "api" | "oauth" | "wellknown"

export interface ProviderConfig {
  name?: string
  api_key?: string
  base_url?: string
  models?: Record<string, unknown>
  npm?: string
  env?: string[]
  options?: Record<string, unknown>
  /** Multiple named API-key accounts for providers that support BYOK auth. */
  accounts?: ProviderAccount[]
  /** How the active account is chosen: manually, on error / credits exhausted, or round robin. */
  accountSwitchingStrategy?: AccountSwitchStrategy
}

/**
 * A single named account (API key) for a provider. A provider may have several
 * accounts; exactly one is active at a time and the switching strategy decides
 * when to fall back to or rotate between them.
 */
export interface ProviderAccount {
  id: string
  name: string
  apiKey: string
  baseUrl?: string
  isActive: boolean
}

export type AccountSwitchStrategy = "manual" | "onError" | "roundRobin"
