export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { type Model } from "@opencode-ai/llm"
import * as AnthropicMessages from "@opencode-ai/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@opencode-ai/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@opencode-ai/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@opencode-ai/llm/route"
import { Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { SessionSchema } from "../schema"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
  },
) {
  override get message() {
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: ModelV2.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {
  override get message() {
    return `Unsupported API for ${this.providerID}/${this.modelID}: ${this.api}`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError
  | Integration.AuthorizationError

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<Model, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRunnerModel") {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"]) => Layer.succeed(Service, Service.of({ resolve }))

// Tracks the next round-robin index per provider. Kept in memory only;
// resets on process restart, which is acceptable for a selection strategy.
const roundRobinIndex = new Map<string, number>()

// Tracks API keys that have failed (e.g. 401 / credits exhausted) per provider,
// used by the "onError" switching strategy. Kept in memory only.
const failedAccountKeys = new Map<string, Set<string>>()

// Tracks the last API key used per provider, so llm.ts can mark it as failed
// on an auth error and trigger a failover retry.
const lastUsedKeyPerProvider = new Map<string, string>()

// Tracks account settings (accounts + switching strategy) per provider,
// populated from the catalog during model resolution so llm.ts can read them
// without accessing ModelV2.Info.api.settings directly.
const providerAccountSettings = new Map<string, {
  accounts?: ProviderAccount[]
  accountSwitchingStrategy?: AccountSwitchStrategy
}>()

/** Mark an API key as failed for a provider so onError skips it next time. */
export function markAccountKeyFailed(providerID: string, apiKey: string) {
  let set = failedAccountKeys.get(providerID)
  if (!set) {
    set = new Set()
    failedAccountKeys.set(providerID, set)
  }
  set.add(apiKey)
}

/** Reset the failed-key tracking for a provider (all accounts have failed). */
export function resetFailedAccountKeys(providerID: string) {
  failedAccountKeys.delete(providerID)
}

/** Returns the account settings for a provider, or undefined if none configured. */
export function getProviderAccountSettings(providerID: string) {
  return providerAccountSettings.get(providerID)
}

const apiKey = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return Auth.value(credential.key)
  if (credential?.type === "oauth") return Auth.value(credential.access)

  const settings = getProviderAccountSettings(model.providerID)
  const accounts = settings?.accounts
  const strategy = settings?.accountSwitchingStrategy
  const fallbackValue = model.request.body.apiKey ?? model.api.settings?.apiKey

  if (accounts && accounts.length > 0) {
    const failed = failedAccountKeys.get(model.providerID)

    if (strategy === "manual") {
      // Manual: user explicitly chose the active account, do not auto-skip
      const active = accounts.find((a) => a.isActive)
      if (active) {
        lastUsedKeyPerProvider.set(model.providerID, active.apiKey)
        return Auth.value(active.apiKey)
      }
    } else {
      // onError or roundRobin: skip keys that have failed
      const available = accounts.filter((a) => !failed?.has(a.apiKey))
      const effective = failed && available.length === 0 ? accounts : available

      if (strategy === "roundRobin") {
        const key = model.providerID
        const idx = (roundRobinIndex.get(key) ?? 0) % effective.length
        roundRobinIndex.set(key, idx + 1)
        const selected = effective[idx]
        lastUsedKeyPerProvider.set(model.providerID, selected.apiKey)
        return Auth.value(selected.apiKey)
      }
      // onError: use the active account, or first available
      const active = effective.find((a) => a.isActive) ?? effective[0]
      lastUsedKeyPerProvider.set(model.providerID, active.apiKey)
      return Auth.value(active.apiKey)
    }
  }

  if (typeof fallbackValue === "string") return Auth.value(fallbackValue)
}

/** Returns the last API key used for a provider, or undefined. */
export function getLastUsedKey(providerID: string): string | undefined {
  return lastUsedKeyPerProvider.get(providerID)
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute) => {
  const body = model.request.body
  const httpBody = Object.hasOwn(body, "apiKey")
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey"))
    : body
  return route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    http: { body: httpBody },
    limits: { context: model.limit.context, output: model.limit.output },
  })
}

const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
): Effect.Effect<ModelV2.Info, VariantUnavailableError> => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant && variantID !== undefined && variantID !== "default")
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    )
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          Object.assign(draft.request.headers, variant.headers)
          Object.assign(draft.request.body, variant.body)
        })
      : model,
  )
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Model, UnsupportedApiError> => {
  const merged =
    credential?.type !== "key" || credential.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.metadata)
        })
  // kilocode_change start - Kilo Gateway consumes the migrated OAuth account as its organization route.
  // Only the account id crosses into the request body; other oauth metadata stays out of provider requests.
  const resolved =
    credential?.type === "oauth" && credential.metadata?.accountID !== undefined
      ? produce(merged, (draft) => {
          draft.request.body.kilocodeOrganizationId = String(credential.metadata!.accountID)
          delete draft.request.body.accountID
        })
      : merged
  // kilocode_change end
  const key = apiKey(resolved, credential)
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai") {
    return Effect.succeed(
      withDefaults(resolved, OpenAIResponses.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/anthropic") {
    return Effect.succeed(
      withDefaults(resolved, AnthropicMessages.route)
        .with({ auth: key === undefined ? Auth.none : Auth.header("x-api-key", key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai-compatible" && resolved.api.url) {
    return Effect.succeed(
      withDefaults(resolved, OpenAICompatibleChat.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  return Effect.fail(
    new UnsupportedApiError({
      providerID: resolved.providerID,
      modelID: resolved.id,
      api: apiName(resolved),
    }),
  )
}

export const resolve = (session: SessionSchema.Info, model: ModelV2.Info, credential?: Credential.Value) =>
  withVariant(model, session.model?.variant).pipe(Effect.flatMap((model) => fromCatalogModel(model, credential)))

export const supported = (model: ModelV2.Info) =>
  model.api.type === "aisdk" &&
  (model.api.package === "@ai-sdk/openai" ||
    model.api.package === "@ai-sdk/anthropic" ||
    (model.api.package === "@ai-sdk/openai-compatible" && model.api.url !== undefined))

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        const defaultModel = session.model ? undefined : yield* catalog.model.default()
        const selected = session.model
          ? (yield* catalog.model.available()).find(
              (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
            )
          : defaultModel && supported(defaultModel)
            ? defaultModel
            : (yield* catalog.model.available()).find(supported)
        if (!selected && session.model)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
        const provider = yield* catalog.provider.get(selected.providerID)
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(selected.providerID),
        )
        // Cache account settings so llm.ts can read them without accessing ModelV2.Info.api.settings
        if (provider.api.settings?.accounts || provider.api.settings?.accountSwitchingStrategy) {
          providerAccountSettings.set(selected.providerID, {
            accounts: provider.api.settings.accounts,
            accountSwitchingStrategy: provider.api.settings.accountSwitchingStrategy,
          })
        }
        return yield* resolve(
          session,
          selected,
          connection ? yield* integrations.connection.resolve(connection) : undefined,
        )
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [Catalog.node, Integration.node] })
