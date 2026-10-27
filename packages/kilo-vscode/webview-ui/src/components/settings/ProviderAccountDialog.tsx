import { Button } from "@kilocode/kilo-ui/button"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { RadioGroup } from "@kilocode/kilo-ui/radio-group"
import { Switch } from "@kilocode/kilo-ui/switch"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { showToast } from "@kilocode/kilo-ui/toast"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Component, For, Show, createSignal, createMemo } from "solid-js"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import type { AccountSwitchStrategy, ProviderAccount, ProviderConfig } from "../../types/messages"

interface ProviderAccountDialogProps {
  providerID: string
}

const STRATEGIES: { value: AccountSwitchStrategy; labelKey: string }[] = [
  { value: "manual", labelKey: "settings.providers.accounts.strategy.manual" },
  { value: "onError", labelKey: "settings.providers.accounts.strategy.onError" },
  { value: "roundRobin", labelKey: "settings.providers.accounts.strategy.roundRobin" },
]

function maskKey(key: string): string {
  if (!key) return ""
  if (key.length <= 8) return "••••••••"
  return "•".repeat(key.length - 4) + key.slice(-4)
}

const ProviderAccountDialog: Component<ProviderAccountDialogProps> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const { config, updateConfig, saveConfig } = useConfig()

  const item = createMemo(() => config().provider?.[props.providerID])
  const providerName = createMemo(() => item()?.name ?? props.providerID)

  // Local draft, seeded from the config when the dialog opens.
  const [accounts, setAccounts] = createSignal<ProviderAccount[]>(item()?.accounts ?? [])
  const [strategy, setStrategy] = createSignal<{ value: AccountSwitchStrategy; labelKey: string }>(
    STRATEGIES.find((s) => s.value === (item()?.accountSwitchingStrategy ?? "manual")) ?? STRATEGIES[0],
  )

  const [adding, setAdding] = createSignal(false)
  const [newName, setNewName] = createSignal("")
  const [newKey, setNewKey] = createSignal("")
  const [newBaseUrl, setNewBaseUrl] = createSignal("")

  const hasAccounts = createMemo(() => accounts().length > 0)

  function nextId() {
    const max = accounts().reduce((maxId, a) => (a.id > maxId ? a.id : maxId), 0)
    return String(Number(max) + 1)
  }

  function addAccount() {
    const name = newName().trim()
    const key = newKey().trim()
    if (!name || !key) {
      showToast({
        title: language.t("common.requestFailed"),
        description: language.t("settings.providers.accounts.error.nameAndKeyRequired"),
      })
      return
    }
    const next: ProviderAccount = {
      id: nextId(),
      name,
      apiKey: key,
      baseUrl: newBaseUrl().trim() || undefined,
      isActive: !hasAccounts(),
    }
    setAccounts([...accounts(), next])
    setNewName("")
    setNewKey("")
    setNewBaseUrl("")
    setAdding(false)
  }

  function removeAccount(id: string) {
    const next = accounts().filter((a) => a.id !== id)
    const wasActive = accounts().find((a) => a.id === id)?.isActive
    setAccounts(
      wasActive && next.length > 0
        ? next.map((a, i) => ({ ...a, isActive: i === 0 }))
        : next,
    )
  }

  function setActive(id: string) {
    setAccounts(accounts().map((a) => ({ ...a, isActive: a.id === id })))
  }

  function toggleActive(id: string) {
    const current = accounts().find((a) => a.id === id)?.isActive
    if (current) return // never deactivate the active account via toggle
    setActive(id)
  }

  function save() {
    const cfg: ProviderConfig = {
      ...(item() ?? {}),
      accounts: accounts(),
      accountSwitchingStrategy: strategy().value,
    }
    updateConfig({ provider: { [props.providerID]: cfg } })
    saveConfig()
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("settings.providers.accounts.toast.saved.title", { provider: providerName() }),
      description: language.t("settings.providers.accounts.toast.saved.description", {
        provider: providerName(),
      }),
    })
    dialog.close()
  }

  return (
    <Dialog title={language.t("settings.providers.accounts.title", { provider: providerName() })} size="large" transition>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
        style={{
          display: "flex",
          "flex-direction": "column",
          gap: "16px",
          padding: "0 16px 16px 16px",
          "overflow-y": "auto",
          flex: 1,
          width: "100%",
          "box-sizing": "border-box",
        }}
      >
        {/* Switching strategy */}
        <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
          <label
            style={{
              "font-size": "var(--kilo-font-size-12)",
              "font-weight": "500",
              color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
            }}
          >
            {language.t("settings.providers.accounts.strategy.label")}
          </label>
          <RadioGroup
            options={STRATEGIES}
            current={strategy()}
            value={(item) => item.value}
            label={(item) => language.t(item.labelKey)}
            onSelect={(next) => {
              if (next) setStrategy(next)
            }}
            fill
          />
        </div>

        {/* Accounts list */}
        <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
          <Show when={hasAccounts()}>
            <For each={accounts()}>
              {(account) => (
                <div
                  key={account.id}
                  style={{
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "space-between",
                    gap: "12px",
                    padding: "8px 12px",
                    border: `1px solid var(${account.isActive ? "--vscode-focusBorder" : "--border-weak-base"})`,
                    "border-radius": "6px",
                    background: account.isActive
                      ? "var(--vscode-list-activeSelectionBackground)"
                      : "transparent",
                  }}
                >
                  <div style={{ display: "flex", "align-items": "center", gap: "12px", "min-width": 0 }}>
                    <TextField
                      style={{ flex: 1, "min-width": 0 }}
                      label={language.t("settings.providers.accounts.name")}
                      value={account.name}
                      onChange={(v) => {
                        setAccounts(
                          accounts().map((a) => (a.id === account.id ? { ...a, name: v } : a)),
                        )
                      }}
                    />
                    <Switch
                      checked={account.isActive}
                      onChange={(checked) => (checked ? setActive(account.id) : toggleActive(account.id))}
                    >
                      {language.t("settings.providers.accounts.active")}
                    </Switch>
                    <span
                      style={{
                        "font-size": "var(--kilo-font-size-11)",
                        color: "var(--vscode-descriptionForeground)",
                        "min-width": "120px",
                        "text-align": "right",
                      }}
                    >
                      {maskKey(account.apiKey)}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    icon="trash"
                    onClick={() => removeAccount(account.id)}
                    title={language.t("common.delete")}
                  />
                </div>
              )}
            </For>
          </Show>
          <Show when={!hasAccounts()}>
            <div
              style={{
                "font-size": "var(--kilo-font-size-13)",
                color: "var(--text-weak-base, var(--vscode-descriptionForeground))",
                padding: "12px 0",
                "text-align": "center",
              }}
            >
              {language.t("settings.providers.accounts.empty")}
            </div>
          </Show>

          {/* Add account form */}
          <Show when={adding()}>
            <div style={{ display: "flex", "flex-direction": "column", gap: "8px", padding: "8px 0" }}>
              <TextField
                autofocus
                label={language.t("settings.providers.accounts.name")}
                placeholder={language.t("settings.providers.accounts.namePlaceholder")}
                value={newName()}
                onChange={setNewName}
              />
              <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                <TextField
                  type="password"
                  label={language.t("settings.providers.accounts.apiKey")}
                  placeholder={language.t("settings.providers.accounts.apiKeyPlaceholder")}
                  value={newKey()}
                  onChange={setNewKey}
                />
                <TextField
                  label={language.t("settings.providers.accounts.baseUrl")}
                  placeholder={language.t("settings.providers.accounts.baseUrlPlaceholder")}
                  value={newBaseUrl()}
                  onChange={setNewBaseUrl}
                />
              </div>
              <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end" }}>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setNewName("")
                    setNewKey("")
                    setNewBaseUrl("")
                    setAdding(false)
                  }}
                >
                  {language.t("common.cancel")}
                </Button>
                <Button size="small" variant="primary" onClick={addAccount}>
                  {language.t("common.add")}
                </Button>
              </div>
            </div>
          </Show>
        </div>

        <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end" }}>
          <Button size="small" variant="secondary" onClick={() => setAdding(true)}>
            {language.t("settings.providers.accounts.add")}
          </Button>
          <Button size="large" variant="ghost" type="button" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button size="large" variant="primary" type="submit">
            {language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export default ProviderAccountDialog
