import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  ArrowLeft,
  Server,
  Laptop,
  AlertCircle,
  Unplug,
  CloudLightning,
  FilePlus,
} from "lucide-react";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { useShallow } from "zustand/react/shallow";
import { SelectMods, useSftpStore } from "../../stores/useSftpStore";
import { useHostStore } from "../../stores/useHostStore";
import { FilePane } from "./FilePane";
import { FileEditorModal } from "./FileEditorModal";
import { TransferConflictModal } from "./TransferConflictModal";
import { TransferProgressOverlay } from "./TransferProgressOverlay";
import { api, FileEntry } from "../../lib/api";
import { CustomSelect } from "../ui/CustomSelect";
import { isMobile } from "../../lib/platform";
import { isAndroidWebView } from "../../lib/androidImeInput";

function getTransferButtonTitle(
  files: FileEntry[],
  direction: "leftToRight" | "rightToLeft",
  leftLabel: string,
  rightLabel: string,
  leftIsRemote: boolean,
  rightIsRemote: boolean
): string {
  let verb = "Copy";
  if (!leftIsRemote && rightIsRemote) {
    verb = direction === "leftToRight" ? "Upload" : "Download";
  } else if (leftIsRemote && !rightIsRemote) {
    verb = direction === "leftToRight" ? "Download" : "Upload";
  } else if (leftIsRemote && rightIsRemote) {
    const target = direction === "leftToRight" ? rightLabel : leftLabel;
    verb = `Copy to ${target}`;
  }

  if (files.length === 0) {
    const source = direction === "leftToRight" ? leftLabel : rightLabel;
    return `Select items in ${source} to transfer`;
  }
  if (files.length === 1) {
    const first = files[0];
    return first.is_dir
      ? `${verb} folder "${first.name}" (recursive)`
      : `${verb} "${first.name}"`;
  }
  const dirCount = files.filter((f) => f.is_dir).length;
  const fileCount = files.length - dirCount;
  const parts: string[] = [];
  if (fileCount > 0) parts.push(`${fileCount} file${fileCount > 1 ? "s" : ""}`);
  if (dirCount > 0) parts.push(`${dirCount} folder${dirCount > 1 ? "s" : ""}`);
  return `${verb} ${parts.join(" & ")} (folders recursive)`;
}

export function SftpView() {
  const { t } = useTranslation();
  const hosts = useHostStore((s) => s.hosts);
  // Mobile shows one pane at a time; both stay mounted so paths, selection
  // and scroll position survive switching.
  const [mobilePane, setMobilePane] = useState<"left" | "right">("left");
  const [editingFile, setEditingFile] = useState<{
    file: FileEntry;
    isRemote: boolean;
    sessionId?: string | null;
    pane: "left" | "right";
  } | null>(null);

  const {
    leftSourceType,
    leftHost,
    leftSessionId,
    leftPath,
    leftEntries,
    leftLoading,
    selectedLeftFiles,

    rightHost,
    rightSessionId,
    rightPath,
    rightEntries,
    rightLoading,
    selectedRightFiles,

    transferring,
    error,

    initLocal,
    setLeftSourceLocal,
    connectLeftRemote,
    disconnectLeft,
    connectRightRemote,
    disconnectRight,
    navigatePane,
    createFolder,
    deleteItems,
    selectFiles,
    setSelection,
    clearSelection,
    selectAll,
    transferLeftToRight,
    transferRightToLeft,
  } = useSftpStore(
    useShallow((s) => ({
      leftSourceType: s.leftSourceType,
      leftHost: s.leftHost,
      leftSessionId: s.leftSessionId,
      leftPath: s.leftPath,
      leftEntries: s.leftEntries,
      leftLoading: s.leftLoading,
      selectedLeftFiles: s.selectedLeftFiles,

      rightHost: s.rightHost,
      rightSessionId: s.rightSessionId,
      rightPath: s.rightPath,
      rightEntries: s.rightEntries,
      rightLoading: s.rightLoading,
      selectedRightFiles: s.selectedRightFiles,

      transferring: s.transferring,
      error: s.error,

      initLocal: s.initLocal,
      setLeftSourceLocal: s.setLeftSourceLocal,
      connectLeftRemote: s.connectLeftRemote,
      disconnectLeft: s.disconnectLeft,
      connectRightRemote: s.connectRightRemote,
      disconnectRight: s.disconnectRight,
      navigatePane: s.navigatePane,
      createFolder: s.createFolder,
      deleteItems: s.deleteItems,
      selectFiles: s.selectFiles,
      setSelection: s.setSelection,
      clearSelection: s.clearSelection,
      selectAll: s.selectAll,
      transferLeftToRight: s.transferLeftToRight,
      transferRightToLeft: s.transferRightToLeft,
    }))
  );

  // Left pane connect / switch handler
  const handleLeftSourceChange = useCallback(
    (value: string) => {
      if (value === "local" || !value) {
        setLeftSourceLocal();
      } else {
        const host = hosts.find((h) => h.id === value);
        if (host) connectLeftRemote(host);
      }
    },
    [hosts, setLeftSourceLocal, connectLeftRemote]
  );

  // Right pane connect handler
  const handleRightHostChange = useCallback(
    (hostId: string) => {
      const host = hosts.find((h) => h.id === hostId);
      if (host) connectRightRemote(host);
    },
    [hosts, connectRightRemote]
  );

  // Selection callbacks
  const selectLeft = useCallback(
    (entry: FileEntry, mods: SelectMods, ordered: FileEntry[]) =>
      selectFiles("left", entry, mods, ordered),
    [selectFiles]
  );
  const selectRight = useCallback(
    (entry: FileEntry, mods: SelectMods, ordered: FileEntry[]) =>
      selectFiles("right", entry, mods, ordered),
    [selectFiles]
  );

  const replaceLeftSelection = useCallback(
    (entries: FileEntry[]) => setSelection("left", entries),
    [setSelection]
  );
  const replaceRightSelection = useCallback(
    (entries: FileEntry[]) => setSelection("right", entries),
    [setSelection]
  );

  const clearLeftSelection = useCallback(() => clearSelection("left"), [clearSelection]);
  const clearRightSelection = useCallback(() => clearSelection("right"), [clearSelection]);

  const selectAllLeft = useCallback(
    (entries: FileEntry[]) => selectAll("left", entries),
    [selectAll]
  );
  const selectAllRight = useCallback(
    (entries: FileEntry[]) => selectAll("right", entries),
    [selectAll]
  );

  // Navigation & CRUD
  const navigateLeft = useCallback(
    (path: string) => navigatePane("left", path),
    [navigatePane]
  );
  const navigateRight = useCallback(
    (path: string) => navigatePane("right", path),
    [navigatePane]
  );

  const refreshLeft = useCallback(() => navigatePane("left", leftPath), [navigatePane, leftPath]);

  // Android: other apps' files are invisible to the local pane (scoped
  // storage), so uploads start by picking files in the system file picker
  // and copying them into the current local folder.
  const [importing, setImporting] = useState(false);
  const importFromPhone = useCallback(async () => {
    try {
      const picked = await openFilePicker({ multiple: true });
      if (!picked) return;
      setImporting(true);
      await api.importLocalFiles(Array.isArray(picked) ? picked : [picked], leftPath);
      navigatePane("left", leftPath);
    } catch (e) {
      // Backing out of the picker rejects; that is not an error worth showing.
      if (!/cancel/i.test(String(e))) useSftpStore.setState({ error: String(e) });
    } finally {
      setImporting(false);
    }
  }, [leftPath, navigatePane]);
  const refreshRight = useCallback(() => navigatePane("right", rightPath), [navigatePane, rightPath]);

  const createLeftFolder = useCallback(
    (name: string) => createFolder("left", name),
    [createFolder]
  );
  const createRightFolder = useCallback(
    (name: string) => createFolder("right", name),
    [createFolder]
  );

  const deleteLeftItems = useCallback(
    (entries: FileEntry[]) => deleteItems("left", entries),
    [deleteItems]
  );
  const deleteRightItems = useCallback(
    (entries: FileEntry[]) => deleteItems("right", entries),
    [deleteItems]
  );

  const openLeftFile = useCallback(
    (entry: FileEntry) =>
      setEditingFile({
        file: entry,
        isRemote: leftSourceType === "remote",
        sessionId: leftSessionId,
        pane: "left",
      }),
    [leftSourceType, leftSessionId]
  );

  const openRightFile = useCallback(
    (entry: FileEntry) =>
      setEditingFile({
        file: entry,
        isRemote: true,
        sessionId: rightSessionId,
        pane: "right",
      }),
    [rightSessionId]
  );

  const transferLeft = useCallback(
    (entries: FileEntry[]) => transferLeftToRight(entries),
    [transferLeftToRight]
  );
  const transferRight = useCallback(
    (entries: FileEntry[]) => transferRightToLeft(entries),
    [transferRightToLeft]
  );

  useEffect(() => {
    initLocal();
  }, [initLocal]);

  const leftIsRemote = leftSourceType === "remote";
  const rightIsRemote = true;
  const isCloudToCloud = leftIsRemote && Boolean(rightSessionId);

  const leftTitle = leftIsRemote ? (leftHost?.label ?? t("sftp.remote")) : t("sftp.localMachine");
  const rightTitle = rightHost?.label ?? t("sftp.remote");

  const leftDisabled = leftIsRemote && !leftSessionId;
  const rightDisabled = !rightSessionId;

  // Header selector for Left Pane
  const leftHeaderSelector = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className={`${isMobile ? "hidden" : "flex"} shrink-0 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-container)] px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)]`}>
        {leftIsRemote ? (
          <Server size={12} className="text-[var(--accent)]" />
        ) : (
          <Laptop size={12} className="text-[var(--text-muted)]" />
        )}
        <span>{t("sftp.source")}</span>
      </div>

      <div className="min-w-0 max-w-[260px] sm:max-w-xs flex-1">
        <CustomSelect
          value={leftIsRemote ? (leftHost?.id ?? "") : "local"}
          onChange={handleLeftSourceChange}
          disabled={leftLoading || transferring}
          placeholder={t("sftp.selectHost")}
          searchable
          compact
          options={[
            {
              value: "local",
              label: `💻 ${t("sftp.localMachine")}`,
              description: "(Local)",
            },
            ...hosts.map((h) => ({
              value: h.id,
              label: `🖥️ ${h.label}`,
              description: `(${h.username}@${h.address})`,
            })),
          ]}
        />
      </div>

      {leftIsRemote && leftSessionId && (
        <button
          onClick={disconnectLeft}
          title="Disconnect and switch back to Local Machine"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-container)] text-[var(--text-muted)] hover:border-[var(--danger)]/40 hover:bg-[var(--danger)]/15 hover:text-[var(--danger)] transition cursor-pointer"
        >
          <Unplug size={12} />
        </button>
      )}
    </div>
  );

  // Header selector for Right Pane
  const rightHeaderSelector = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className={`${isMobile ? "hidden" : "flex"} shrink-0 items-center gap-1.5 rounded-md border border-[var(--primary)]/30 bg-[var(--primary)]/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--primary)]`}>
        <Server size={12} />
        <span>{t("sftp.destination")}</span>
      </div>

      <div className="min-w-0 max-w-[260px] sm:max-w-xs flex-1">
        <CustomSelect
          value={rightHost?.id ?? ""}
          onChange={handleRightHostChange}
          disabled={rightLoading || transferring}
          placeholder={t("sftp.selectHost")}
          searchable
          compact
          options={[
            { value: "", label: t("sftp.selectHost") },
            ...hosts.map((h) => ({
              value: h.id,
              label: `🖥️ ${h.label}`,
              description: `(${h.username}@${h.address})`,
            })),
          ]}
        />
      </div>

      {rightSessionId && (
        <button
          onClick={disconnectRight}
          title="Disconnect SFTP Session"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-container)] text-[var(--text-muted)] hover:border-[var(--danger)]/40 hover:bg-[var(--danger)]/15 hover:text-[var(--danger)] transition cursor-pointer"
        >
          <Unplug size={12} />
        </button>
      )}
    </div>
  );

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-[var(--canvas)] p-3">
      {/* Floating transfer progress widget (top-right, self-subscribing) */}
      <TransferProgressOverlay />

      {/* Error alert if any */}
      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-[var(--danger)]/30 bg-[var(--danger)]/10 px-3 py-2 text-xs text-[var(--danger)]">
          <AlertCircle size={14} className="shrink-0" />
          <span className="whitespace-pre-wrap">{error}</span>
        </div>
      )}

      {/* Mobile: pane switcher */}
      {isMobile && (
        <div className="mb-2 flex shrink-0 gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-container)] p-1">
          {(
            [
              ["left", t("sftp.source"), leftTitle, selectedLeftFiles.length],
              ["right", t("sftp.destination"), rightTitle, selectedRightFiles.length],
            ] as const
          ).map(([pane, role, title, count]) => (
            <button
              key={pane}
              type="button"
              onClick={() => setMobilePane(pane)}
              aria-pressed={mobilePane === pane}
              className={`flex min-w-0 flex-1 flex-col items-center rounded-lg px-2 py-1.5 transition-colors ${
                mobilePane === pane
                  ? "bg-[var(--surface-highest)] text-[var(--primary)]"
                  : "text-[var(--text-muted)]"
              }`}
            >
              <span className="text-[9px] font-bold uppercase tracking-wider">
                {role}
                {count > 0 ? ` · ${count}` : ""}
              </span>
              <span className="max-w-full truncate text-xs font-medium">{title}</span>
            </button>
          ))}
        </div>
      )}

      {/* Dual Pane + Center Transfer Buttons */}
      <div className="flex min-h-0 flex-1 gap-2 overflow-hidden">
        {/* Left Pane: Local or Remote 1 */}
        <div className={isMobile ? (mobilePane === "left" ? "flex min-w-0 flex-1" : "hidden") : "contents"}>
        <FilePane
          headerLeft={leftHeaderSelector}
          path={leftPath}
          entries={leftEntries}
          loading={leftLoading}
          selectedFiles={selectedLeftFiles}
          onSelect={selectLeft}
          onSelectionReplace={replaceLeftSelection}
          onClearSelection={clearLeftSelection}
          onSelectAll={selectAllLeft}
          onNavigate={navigateLeft}
          onCreateFolder={createLeftFolder}
          onDeleteItems={deleteLeftItems}
          onRefresh={refreshLeft}
          onOpenFile={openLeftFile}
          disabled={leftDisabled}
          onTransfer={transferLeft}
        />
        </div>

        {/* Center Transfer Buttons & Bridge Badge */}
        <div className={isMobile ? "hidden" : "flex shrink-0 flex-col items-center justify-center gap-2 px-1"}>
          {isCloudToCloud && (
            <div
              className="mb-1 flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/15 text-[var(--accent)] shadow-sm transition hover:bg-[var(--accent)]/25 cursor-help"
              title={t("sftp.cloudBridgeInfo")}
            >
              <CloudLightning size={16} />
            </div>
          )}

          <button
            onClick={() => transferLeftToRight()}
            disabled={
              selectedLeftFiles.length === 0 ||
              rightDisabled ||
              leftDisabled ||
              transferring
            }
            title={getTransferButtonTitle(
              selectedLeftFiles,
              "leftToRight",
              leftTitle,
              rightTitle,
              leftIsRemote,
              rightIsRemote
            )}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)] text-white shadow-md transition hover:bg-[var(--accent-hover)] disabled:opacity-20 cursor-pointer disabled:cursor-not-allowed"
          >
            <ArrowRight size={16} />
          </button>

          <button
            onClick={() => transferRightToLeft()}
            disabled={
              selectedRightFiles.length === 0 ||
              rightDisabled ||
              leftDisabled ||
              transferring
            }
            title={getTransferButtonTitle(
              selectedRightFiles,
              "rightToLeft",
              leftTitle,
              rightTitle,
              leftIsRemote,
              rightIsRemote
            )}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)] text-white shadow-md transition hover:bg-[var(--accent-hover)] disabled:opacity-20 cursor-pointer disabled:cursor-not-allowed"
          >
            <ArrowLeft size={16} />
          </button>
        </div>

        {/* Right Pane: Remote Server 2 */}
        <div className={isMobile ? (mobilePane === "right" ? "flex min-w-0 flex-1" : "hidden") : "contents"}>
        <FilePane
          headerLeft={rightHeaderSelector}
          path={rightPath}
          entries={rightEntries}
          loading={rightLoading}
          selectedFiles={selectedRightFiles}
          onSelect={selectRight}
          onSelectionReplace={replaceRightSelection}
          onClearSelection={clearRightSelection}
          onSelectAll={selectAllRight}
          onNavigate={navigateRight}
          onCreateFolder={createRightFolder}
          onDeleteItems={deleteRightItems}
          onRefresh={refreshRight}
          onOpenFile={openRightFile}
          disabled={rightDisabled}
          onTransfer={transferRight}
        />
        </div>
      </div>

      {/* Mobile: transfer the active pane's selection to the other side */}
      {isMobile && (() => {
        const fromLeft = mobilePane === "left";
        const selected = fromLeft ? selectedLeftFiles : selectedRightFiles;
        if (selected.length === 0) {
          if (!(fromLeft && !leftIsRemote && isAndroidWebView())) return null;
          return (
            <button
              type="button"
              onClick={importFromPhone}
              disabled={importing || transferring}
              className="mt-2 flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-high)] px-4 text-sm font-medium text-[var(--text-primary)] disabled:opacity-40"
            >
              <FilePlus size={16} />
              <span className="truncate">
                {importing ? t("sftp.importingFromPhone") : t("sftp.importFromPhone")}
              </span>
            </button>
          );
        }
        return (
          <button
            type="button"
            onClick={() => (fromLeft ? transferLeftToRight() : transferRightToLeft())}
            disabled={rightDisabled || leftDisabled || transferring}
            className="mt-2 flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--primary)] px-4 text-sm font-semibold text-[var(--on-primary)] disabled:opacity-40"
          >
            {fromLeft ? <ArrowRight size={16} /> : <ArrowLeft size={16} />}
            <span className="truncate">
              {t("sftp.sendTo", { count: selected.length, target: fromLeft ? rightTitle : leftTitle })}
            </span>
          </button>
        );
      })()}

      {/* Transfer-conflict modal (self-subscribing, renders null when idle) */}
      <TransferConflictModal />

      {/* In-App SFTP File Editor Modal */}
      {editingFile && (
        <FileEditorModal
          file={editingFile.file}
          isRemote={editingFile.isRemote}
          sessionId={editingFile.sessionId}
          onClose={() => setEditingFile(null)}
          onSaved={() => {
            if (editingFile.pane === "left") {
              navigatePane("left", leftPath);
            } else {
              navigatePane("right", rightPath);
            }
          }}
        />
      )}
    </div>
  );
}
