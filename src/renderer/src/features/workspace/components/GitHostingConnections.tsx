import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ExternalLink, Eye, EyeOff, Plus } from "lucide-react";
import { toast } from "sonner";
import { gitHostingTokenUrl, normalizeGitHostingUrl, saveGitHostingConnectionSchema } from "@/shared/git-hosting";
import type { GitHostingConnection, GitHostingProvider } from "@/shared/git-hosting";
import { hostingErrorMessage, useGitHostingConnections } from "../merge-request-queries";
import { Modal } from "./Modal";

export interface ConnectionEditorOptions {
  workspaceId?: string;
  connection?: GitHostingConnection;
  suggestedProvider?: GitHostingProvider;
  suggestedBaseUrl?: string;
  onConnected(): void;
}
export function useConnectionEditor(options: ConnectionEditorOptions) {
  const connections = useGitHostingConnections();
  const [provider, setProvider] = useState<GitHostingProvider>(options.connection?.provider ?? options.suggestedProvider ?? "github");
  const [baseUrl, setBaseUrl] = useState(options.connection?.baseUrl ?? options.suggestedBaseUrl ?? "https://github.com");
  const [token, setToken] = useState("");
  const [savedId, setSavedId] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [validationAnnouncement, setValidationAnnouncement] = useState("");
  useEffect(() => {
    const message = Object.values(fieldErrors).filter(Boolean).join(" ");
    if (!message) { setValidationAnnouncement(""); return; }
    const timer = window.setTimeout(() => setValidationAnnouncement(message), 500);
    return () => window.clearTimeout(timer);
  }, [fieldErrors]);
  const addressInput = useRef<HTMLInputElement>(null), tokenInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const validateAddress = (): string => { try { normalizeGitHostingUrl(baseUrl); return ""; } catch { return "Enter an HTTP or HTTPS platform address, including any deployment path prefix."; } };
  const validateToken = (): string => /^\S+$/.test(token) ? "" : "Enter a Token without whitespace.";
  const validateField = (field: "baseUrl" | "token"): void => setFieldErrors((current) => ({ ...current, [field]: field === "baseUrl" ? validateAddress() : validateToken() }));
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    if (!savedId) {
      const addressError = validateAddress(), tokenError = validateToken();
      setFieldErrors({ baseUrl: addressError, token: tokenError });
      if (addressError || tokenError) { (addressError ? addressInput : tokenInput).current?.focus(); return; }
    }
    setBusy(true); setError("");
    try {
      if (savedId && options.workspaceId) await window.desktop.bindGitHostingConnection({ workspaceId: options.workspaceId, connectionId: savedId });
      else {
        const parsed = saveGitHostingConnectionSchema.safeParse({ provider, baseUrl, token, workspaceId: options.workspaceId });
        if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Check the connection details.");
        await window.desktop.saveGitHostingConnection(parsed.data);
      }
      setToken(""); setShowToken(false);
      await connections.refetch();
      options.onConnected();
    } catch (cause) { setError(hostingErrorMessage(cause)); }
    finally { setBusy(false); }
  };
  const openTokenPage = (): void => {
    try { void window.desktop.openDocumentLink(gitHostingTokenUrl(provider, baseUrl)).catch((cause) => setError(hostingErrorMessage(cause))); }
    catch { setFieldErrors((current) => ({ ...current, baseUrl: validateAddress() })); addressInput.current?.focus(); }
  };
  return { ...options, connections, provider, setProvider, baseUrl, setBaseUrl, token, setToken, savedId, setSavedId, showToken, setShowToken, busy, error, fieldErrors, setFieldErrors, validationAnnouncement, validateField, addressInput, tokenInput, id, save, openTokenPage };
}

export function GitHostingConnectionFields({ editor }: { editor: ReturnType<typeof useConnectionEditor> }): React.ReactNode {
  const e = editor;
  const selected = e.connections.data?.find((item) => item.id === e.savedId);
  return <fieldset className="hosting-fields" disabled={e.busy}>
    <legend>Connect code hosting on this Mac</legend>
    <span className="hosting-validation-status" role="status" aria-live="polite">{e.validationAnnouncement}</span>
    <p className="settings-hint">One connection is shared by this Mac’s workspaces. SSH devices do not need gh/glab or a copy of this Token.</p>
    {e.workspaceId && Boolean(e.connections.data?.length) && <label className="field"><span>Connection</span><select name="hostingConnection" value={e.savedId} onChange={(event) => e.setSavedId(event.target.value)}><option value="">Add connection or replace Token</option>{e.connections.data?.map((item) => <option key={item.id} value={item.id}>{item.username} · {item.baseUrl}</option>)}</select></label>}
    {selected ? <p className="settings-hint">Use {selected.username} on {selected.baseUrl} for this device’s Git remote host. Repository access will be checked before saving the mapping.</p> : <>
      <fieldset className="hosting-provider"><legend>Platform</legend>{(["github", "gitlab"] as const).map((provider) => <label key={provider}><input type="radio" name={`${e.id}-provider`} checked={e.provider === provider} value={provider} onChange={() => { e.setProvider(provider); e.setBaseUrl(provider === "github" ? "https://github.com" : e.suggestedBaseUrl ?? "https://gitlab.com"); e.setFieldErrors({}); }} /> {provider === "github" ? "GitHub.com" : "GitLab / self-hosted"}</label>)}</fieldset>
      <div className="field"><label htmlFor={`${e.id}-address`}>Platform address (required)</label><small id={`${e.id}-address-hint`}>Confirm the actual web address if Git uses an SSH alias. HTTP and HTTPS addresses, custom ports, and GitLab path prefixes are supported.</small><input ref={e.addressInput} id={`${e.id}-address`} name="hostingBaseUrl" type="url" value={e.baseUrl} required maxLength={2048} readOnly={e.provider === "github"} autoCorrect="off" autoCapitalize="none" spellCheck={false} aria-invalid={Boolean(e.fieldErrors.baseUrl)} aria-describedby={`${e.id}-address-hint${e.fieldErrors.baseUrl ? ` ${e.id}-address-error` : ""}`} onBlur={() => e.validateField("baseUrl")} onChange={(event) => { e.setBaseUrl(event.target.value); e.setFieldErrors((current) => ({ ...current, baseUrl: "" })); }} />{e.fieldErrors.baseUrl && <small id={`${e.id}-address-error`} className="field-error">{e.fieldErrors.baseUrl}</small>}</div>
      <p className="settings-hint">{e.provider === "github" ? "Create a fine-grained personal Token for the intended repositories: Pull requests — Read and write; Contents — Read. Organization approval may be required." : "Create a personal access Token with the api scope. Only read_api or repository scopes are insufficient to create merge requests."}</p>
      <button type="button" className="button" onClick={e.openTokenPage}><ExternalLink size={14} /> Create Token in browser</button>
      <div className="field"><label htmlFor={`${e.id}-token`}>Personal access Token (required)</label><small id={`${e.id}-token-hint`}>Encrypted on this Mac. Validation checks your account and repository read access; write permissions are checked by the platform when creating the request.</small><div className="path-control"><input ref={e.tokenInput} id={`${e.id}-token`} name="hostingToken" type={e.showToken ? "text" : "password"} autoComplete="new-password" autoCorrect="off" autoCapitalize="none" spellCheck={false} required maxLength={16384} value={e.token} aria-invalid={Boolean(e.fieldErrors.token)} aria-describedby={`${e.id}-token-hint${e.fieldErrors.token ? ` ${e.id}-token-error` : ""}`} onBlur={() => e.validateField("token")} onChange={(event) => { e.setToken(event.target.value); e.setFieldErrors((current) => ({ ...current, token: "" })); }} /><button type="button" className="icon-button" aria-label={e.showToken ? "Hide Token" : "Show Token"} aria-pressed={e.showToken} onClick={() => e.setShowToken(!e.showToken)}>{e.showToken ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>{e.fieldErrors.token && <small id={`${e.id}-token-error`} className="field-error">{e.fieldErrors.token}</small>}</div>
    </>}
    {e.error && <p className="field-error" role="alert">{e.error}</p>}
  </fieldset>;
}

function ConnectionDialog({ connection, onClose }: { connection?: GitHostingConnection; onClose(): void }): React.ReactNode {
  const editor = useConnectionEditor({ connection, onConnected: () => { toast.success("Code hosting connected"); onClose(); } });
  return <Modal open title={connection ? "Replace hosting Token" : "Connect code hosting"} description="Manage platform API access from this Mac." busy={editor.busy} submitLabel="Verify & connect" onClose={onClose} onSubmit={(event) => void editor.save(event)}><GitHostingConnectionFields editor={editor} /></Modal>;
}

export function GitHostingSettings(): React.ReactNode {
  const connections = useGitHostingConnections();
  const [editing, setEditing] = useState<GitHostingConnection | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const action = async (id: string, remove = false): Promise<void> => {
    setBusyId(id);
    try {
      if (remove) await window.desktop.removeGitHostingConnection(id); else await window.desktop.verifyGitHostingConnection(id);
      await connections.refetch(); setRemovingId(null);
      toast.success(remove ? "Connection removed from this Mac" : "Account connection verified");
    } catch (error) { toast.error(hostingErrorMessage(error)); }
    finally { setBusyId(null); }
  };
  return <section className="hosting-settings" aria-labelledby="hosting-settings-title"><h3 id="hosting-settings-title">Code hosting connections</h3><p className="settings-hint">API access is managed on this Mac. Git push uses each workspace device’s existing Git authentication.</p>
    {connections.isPending && <p role="status">Loading connections…</p>}
    {connections.isError && <p className="field-error" role="alert">{hostingErrorMessage(connections.error)} <button type="button" className="button" onClick={() => void connections.refetch()}>Retry</button></p>}
    {connections.data?.length === 0 && <p className="settings-hint">No platforms connected yet.</p>}
    {connections.data?.map((item) => <div className="hosting-connection" key={item.id}><strong>{item.username} · {item.provider === "github" ? "GitHub" : "GitLab"}</strong><span className="selectable">{item.baseUrl}</span><small>Last verified {new Date(item.verifiedAt).toLocaleString()}</small><div className="hosting-actions"><button type="button" className="button" disabled={Boolean(busyId)} onClick={() => void action(item.id)}>Verify</button><button type="button" className="button" disabled={Boolean(busyId)} onClick={() => setEditing(item)}>Replace Token</button><button type="button" className="button danger" disabled={Boolean(busyId)} onClick={() => setRemovingId(item.id)}>Remove</button></div>{removingId === item.id && <div><p>Remove this connection and its saved remote mappings from this Mac? The Token remains active on the platform.</p><div className="hosting-actions"><button type="button" className="button" disabled={Boolean(busyId)} onClick={() => setRemovingId(null)}>Keep connection</button><button type="button" className="button danger" disabled={Boolean(busyId)} onClick={() => void action(item.id, true)}>Remove connection</button></div></div>}</div>)}
    <button type="button" className="button" onClick={() => setEditing("new")}><Plus size={14} /> Add connection</button>
    {editing && <ConnectionDialog connection={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
  </section>;
}
