import { Checkbox } from "@kobalte/core/checkbox";
import { Dialog } from "@kobalte/core/dialog";
import { Tabs } from "@kobalte/core/tabs";
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { createSeedProject, uid } from "../data";
import {
  applyEntryToText,
  chainBlockingEntry,
  findChains,
  scanMatches,
  validateEntryDraft,
} from "../glossary";
import { downloadText, formatTime, loadProject, parseTime, saveProject } from "../persistence";
import type {
  Confidence,
  GlossaryEntry,
  PersistedEnvelope,
  ProjectData,
  Segment,
  TranscriptTrack,
} from "../types";

const CHANNEL_NAME = "sologsb-1007-editor";
const TAB_ID = uid("tab");

function statusText(status: "saved" | "saving" | "offline") {
  if (status === "saving") return "正在保存";
  if (status === "offline") return "离线草稿";
  return "已自动保存";
}

function parseTimedTranscript(input: string, trackName: string): TranscriptTrack {
  const blocks = input.trim().split(/\n\s*\n/);
  const segments: Segment[] = [];
  const srtPattern = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
  const bracketPattern = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*(.*)$/;

  for (const rawBlock of blocks) {
    const lines = rawBlock.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const srtIndex = lines.findIndex((line) => srtPattern.test(line));
    if (srtIndex >= 0) {
      const match = srtPattern.exec(lines[srtIndex]);
      const text = lines.slice(srtIndex + 1).join(" ");
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push({
        id: uid("seg"),
        start: parseTime(match?.[1] ?? "0"),
        end: parseTime(match?.[2] ?? "1"),
        speakerId: speakerName ? "sp-custom" : "sp-interviewer",
        text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
      });
      continue;
    }
    for (const line of lines) {
      const match = bracketPattern.exec(line);
      if (!match) continue;
      const start = parseTime(match[1]);
      const text = match[2];
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push({
        id: uid("seg"),
        start,
        end: start + Math.max(3, text.length / 5),
        speakerId: speakerName ? "sp-custom" : "sp-interviewer",
        text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
      });
    }
  }

  if (!segments.length && input.trim()) {
    input.split("\n").map((line) => line.trim()).filter(Boolean).forEach((text, index) => {
      segments.push({
        id: uid("seg"),
        start: index * 6,
        end: index * 6 + 5.4,
        speakerId: "sp-interviewer",
        text,
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
      });
    });
  }

  return {
    id: uid("track"),
    name: trackName || "导入轨",
    language: "待识别",
    status: "待校对",
    segments,
  };
}

export default function OralHistoryEditor() {
  const loaded = loadProject();
  const [project, setProject] = createSignal<ProjectData>(loaded.project);
  const [revision, setRevision] = createSignal(loaded.revision);
  const [past, setPast] = createSignal<ProjectData[]>([]);
  const [future, setFuture] = createSignal<ProjectData[]>([]);
  const [selectedId, setSelectedId] = createSignal(loaded.project.tracks[0]?.segments[0]?.id ?? "");
  const [saveStatus, setSaveStatus] = createSignal<"saved" | "saving" | "offline">("saved");
  const [lastAction, setLastAction] = createSignal("示例项目已就绪");
  const [conflict, setConflict] = createSignal<PersistedEnvelope | null>(null);
  const [online, setOnline] = createSignal(true);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [commentDraft, setCommentDraft] = createSignal("");
  const [replyDrafts, setReplyDrafts] = createSignal<Record<string, string>>({});
  const [trackFilter, setTrackFilter] = createSignal<"all" | "unreviewed" | "low">("all");
  const [glossaryOpen, setGlossaryOpen] = createSignal(false);
  const [entryFrom, setEntryFrom] = createSignal("");
  const [entryTo, setEntryTo] = createSignal("");
  const [glossaryNotice, setGlossaryNotice] = createSignal<{ kind: "info" | "warn" | "error"; text: string } | null>(null);
  let editorRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let saveTimer: number | undefined;
  let hydrated = false;
  let dirty = false;

  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;
  const activeTrack = createMemo(() => {
    const data = project();
    return data.tracks.find((track) => track.id === data.activeTrackId) ?? data.tracks[0];
  });
  const activeSegment = createMemo(() => activeTrack()?.segments.find((item) => item.id === selectedId()) ?? null);
  const visibleSegments = createMemo(() => {
    const segments = activeTrack()?.segments ?? [];
    if (trackFilter() === "unreviewed") return segments.filter((segment) => !segment.reviewed);
    if (trackFilter() === "low") return segments.filter((segment) => segment.confidence <= 2 || segment.flags.lowConfidence);
    return segments;
  });
  const completedPercent = createMemo(() => {
    const segments = project().tracks.flatMap((track) => track.segments);
    if (!segments.length) return 0;
    return Math.round((segments.filter((segment) => segment.reviewed).length / segments.length) * 100);
  });
  const speakerById = (speakerId: string) =>
    project().speakers.find((speaker) => speaker.id === speakerId) ?? project().speakers[0];
  const tagById = (tagId: string) => project().tags.find((tag) => tag.id === tagId);

  // 词条校对：错写法越长优先级越高，与扫描时的最长匹配保持一致。
  const glossaryEntries = createMemo(() =>
    [...project().glossary].sort((a, b) => b.from.length - a.from.length || a.id.localeCompare(b.id)),
  );
  // 「规范写法又是另一条错写法」的词条对，登记后即时说明是哪两条。
  const glossaryChains = createMemo(() => findChains(project().glossary));
  interface SegmentHit {
    segment: Segment;
    total: number;
    perEntry: Map<string, number>;
  }
  // 打开面板时，只列出当前轨道里还能命中词条的片段。
  const trackHits = createMemo<SegmentHit[]>(() => {
    const entries = project().glossary;
    const hits: SegmentHit[] = [];
    for (const segment of activeTrack()?.segments ?? []) {
      // 计数与应用共用同一次最长优先扫描：套在更长词条内部的短词条不重复计数。
      const matches = scanMatches(segment.text, entries);
      if (!matches.length) continue;
      const perEntry = new Map<string, number>();
      for (const match of matches) perEntry.set(match.entryId, (perEntry.get(match.entryId) ?? 0) + 1);
      hits.push({ segment, total: matches.length, perEntry });
    }
    return hits;
  });
  const entryHitTotal = (entryId: string) =>
    trackHits().reduce((sum, hit) => sum + (hit.perEntry.get(entryId) ?? 0), 0);
  const entryById = (entryId: string) => project().glossary.find((entry) => entry.id === entryId);
  const highlightParts = (text: string) => {
    const matches = scanMatches(text, project().glossary);
    const parts: { text: string; hit?: GlossaryEntry }[] = [];
    let cursor = 0;
    for (const match of matches) {
      if (match.start > cursor) parts.push({ text: text.slice(cursor, match.start) });
      parts.push({ text: text.slice(match.start, match.end), hit: entryById(match.entryId) });
      cursor = match.end;
    }
    if (cursor < text.length) parts.push({ text: text.slice(cursor) });
    return parts;
  };

  const commit = (label: string, mutate: (draft: ProjectData) => void) => {
    const current = structuredClone(project());
    const next = structuredClone(current);
    mutate(next);
    next.updatedAt = new Date().toISOString();
    batch(() => {
      setPast((items) => [...items.slice(-49), current]);
      setFuture([]);
      setProject(next);
      setRevision((value) => value + 1);
      setLastAction(label);
    });
    dirty = true;
  };

  const commitSegment = (label: string, mutate: (segment: Segment, draft: ProjectData) => void) => {
    const id = selectedId();
    commit(label, (draft) => {
      const track = draft.tracks.find((item) => item.id === draft.activeTrackId);
      const segment = track?.segments.find((item) => item.id === id);
      if (segment) mutate(segment, draft);
    });
  };

  const undo = () => {
    const stack = past();
    if (!stack.length) return;
    const previous = stack[stack.length - 1];
    setFuture((items) => [structuredClone(project()), ...items].slice(0, 50));
    setPast(stack.slice(0, -1));
    setProject(previous);
    setRevision((value) => value + 1);
    setLastAction("已撤销上一步");
    dirty = true;
  };

  const redo = () => {
    const stack = future();
    if (!stack.length) return;
    const next = stack[0];
    setPast((items) => [...items.slice(-49), structuredClone(project())]);
    setFuture(stack.slice(1));
    setProject(next);
    setRevision((value) => value + 1);
    setLastAction("已重做");
    dirty = true;
  };

  const switchTrack = (trackId: string) => {
    commit("切换文本轨", (draft) => {
      draft.activeTrackId = trackId;
      selectedIdSet(draft.tracks.find((track) => track.id === trackId)?.segments[0]?.id ?? "");
    });
  };

  const selectedIdSet = (id: string) => setSelectedId(id);

  const moveSelection = (direction: 1 | -1) => {
    const segments = activeTrack()?.segments ?? [];
    if (!segments.length) return;
    const index = Math.max(0, segments.findIndex((segment) => segment.id === selectedId()));
    const nextIndex = (index + direction + segments.length) % segments.length;
    setSelectedId(segments[nextIndex].id);
    document.getElementById(`segment-${segments[nextIndex].id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const splitSelection = () => {
    const segment = activeSegment();
    if (!segment || segment.text.trim().length < 2) return;
    const cursor = editorRef?.selectionStart ?? Math.floor(segment.text.length / 2);
    const safeCursor = Math.max(1, Math.min(cursor, segment.text.length - 1));
    const firstText = segment.text.slice(0, safeCursor).trim();
    const secondText = segment.text.slice(safeCursor).trim();
    if (!firstText || !secondText) return;
    const ratio = firstText.length / segment.text.length;
    const boundary = segment.start + (segment.end - segment.start) * ratio;
    const secondId = uid("seg");
    commitSegment("拆分片段", (current, draft) => {
      const original = structuredClone(current);
      current.text = firstText;
      current.end = Number(boundary.toFixed(1));
      const trackIndex = draft.tracks.findIndex((track) => track.id === draft.activeTrackId);
      if (trackIndex >= 0) {
        const segmentIndex = draft.tracks[trackIndex].segments.findIndex((item) => item.id === current.id);
        draft.tracks[trackIndex].segments.splice(segmentIndex + 1, 0, {
          ...original,
          id: secondId,
          start: Number(boundary.toFixed(1)),
          text: secondText,
          reviewed: false,
          comments: [],
        });
      }
      setSelectedId(secondId);
    });
  };

  const mergeWithNext = () => {
    const track = activeTrack();
    const segment = activeSegment();
    if (!track || !segment) return;
    const index = track.segments.findIndex((item) => item.id === segment.id);
    const next = track.segments[index + 1];
    if (!next) return;
    commitSegment("合并下一片段", (current, draft) => {
      current.text = `${current.text.trim()} ${next.text.trim()}`;
      current.end = next.end;
      current.tagIds = [...new Set([...current.tagIds, ...next.tagIds])];
      current.comments.push(...next.comments);
      current.confidence = Math.min(current.confidence, next.confidence) as Confidence;
      const sourceTrack = draft.tracks.find((item) => item.id === draft.activeTrackId);
      sourceTrack?.segments.splice(index + 1, 1);
      current.reviewed = false;
    });
  };

  const toggleFlag = (flag: keyof Segment["flags"]) => {
    commitSegment("修改校对标记", (segment) => {
      segment.flags[flag] = !segment.flags[flag];
      segment.reviewed = false;
    });
  };

  const setConfidence = (confidence: Confidence) => {
    commitSegment("校正置信度", (segment) => {
      segment.confidence = confidence;
      segment.flags.lowConfidence = confidence <= 2;
      segment.reviewed = false;
    });
  };

  const addComment = () => {
    const body = commentDraft().trim();
    if (!body) return;
    commitSegment("添加批注", (segment) => {
      segment.comments.unshift({
        id: uid("comment"),
        author: "当前校对员",
        body,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      });
      segment.reviewed = false;
    });
    setCommentDraft("");
  };

  const addReply = (commentId: string) => {
    const body = (replyDrafts()[commentId] ?? "").trim();
    if (!body) return;
    commitSegment("回复批注", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      comment?.replies.push({
        id: uid("reply"),
        author: "当前校对员",
        body,
        createdAt: new Date().toISOString(),
      });
    });
    setReplyDrafts((drafts) => ({ ...drafts, [commentId]: "" }));
  };

  const toggleComment = (commentId: string) => {
    commitSegment("更新批注状态", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    });
  };

  const toggleTag = (tagId: string) => {
    commitSegment("更新主题关联", (segment) => {
      segment.tagIds = segment.tagIds.includes(tagId)
        ? segment.tagIds.filter((id) => id !== tagId)
        : [...segment.tagIds, tagId];
      segment.reviewed = false;
    });
  };

  const addGlossaryEntry = () => {
    const issue = validateEntryDraft(entryFrom(), entryTo(), project().glossary);
    if (issue) {
      setGlossaryNotice({ kind: "error", text: issue.message });
      return;
    }
    const entry: GlossaryEntry = { id: uid("gloss"), from: entryFrom().trim(), to: entryTo().trim() };
    commit("登记词条", (draft) => {
      draft.glossary.push(entry);
    });
    setEntryFrom("");
    setEntryTo("");
    setGlossaryNotice({ kind: "info", text: `已登记词条「${entry.from} → ${entry.to}」，随草稿保存在本机。` });
  };

  const removeGlossaryEntry = (entry: GlossaryEntry) => {
    commit("删除词条", (draft) => {
      draft.glossary = draft.glossary.filter((item) => item.id !== entry.id);
    });
    setGlossaryNotice({ kind: "info", text: `已删除词条「${entry.from} → ${entry.to}」。` });
  };

  const applyGlossaryEntry = (segmentId: string, entry: GlossaryEntry) => {
    // 规范写法又是另一条错写法时停下：改完会立刻被另一条命中，改写链有歧义，需人工裁决。
    const chained = chainBlockingEntry(entry, project().glossary);
    if (chained) {
      setGlossaryNotice({
        kind: "error",
        text: `已停下：词条「${entry.from} → ${entry.to}」的规范写法「${entry.to}」恰好是另一条词条「${chained.from} → ${chained.to}」的错写法。请先修改或删除其中一条，再应用。`,
      });
      return;
    }
    const target = activeTrack()?.segments.find((item) => item.id === segmentId);
    if (!target) return;
    const count = scanMatches(target.text, project().glossary).filter((match) => match.entryId === entry.id).length;
    if (!count) {
      setGlossaryNotice({ kind: "warn", text: `当前片段已没有「${entry.from}」的独立命中（可能套在更长的词条里，或刚被改过）。` });
      return;
    }
    commit("应用词条校对", (draft) => {
      const track = draft.tracks.find((item) => item.id === draft.activeTrackId);
      const current = track?.segments.find((item) => item.id === segmentId);
      if (!current) return;
      current.text = applyEntryToText(current.text, entry, draft.glossary);
      // 文本被改写后退回未校对，重新人工确认。
      current.reviewed = false;
    });
    setSelectedId(segmentId);
    setGlossaryNotice({
      kind: "info",
      text: `已将本片段中「${entry.from}」的 ${count} 处全部改为「${entry.to}」，该片段已退回未校对。`,
    });
  };

  const exportSrt = () => {
    const lines = activeTrack().segments.map((segment, index) => {
      const speaker = speakerById(segment.speakerId)?.name ?? "未知";
      return `${index + 1}\n${formatTime(segment.start)} --> ${formatTime(segment.end)}\n${speaker}：${segment.text}\n`;
    });
    downloadText(`${project().title}-${activeTrack().name}.srt`, lines.join("\n"), "application/x-subrip;charset=utf-8");
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    const imported = parseTimedTranscript(text, file.name.replace(/\.[^.]+$/, ""));
    if (!imported.segments.length) {
      setLastAction("未识别到带时间码的文本");
      return;
    }
    commit("导入转写文本", (draft) => {
      draft.tracks.push(imported);
      draft.activeTrackId = imported.id;
      setSelectedId(imported.segments[0].id);
    });
  };

  const resolveConflict = (useIncoming: boolean) => {
    const incoming = conflict();
    if (!incoming) return;
    if (useIncoming) {
      setPast((items) => [...items.slice(-49), structuredClone(project())]);
      setProject(structuredClone(incoming.project));
      setRevision(incoming.revision + 1);
      setSelectedId(incoming.project.tracks.find((track) => track.id === incoming.project.activeTrackId)?.segments[0]?.id ?? "");
      setLastAction("已采用其他标签页的版本");
      dirty = true;
    } else {
      setRevision((value) => value + 1);
      setLastAction("已保留本页并覆盖冲突版本");
      dirty = true;
    }
    setConflict(null);
  };

  onMount(() => {
    hydrated = true;
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "sologsb-1007-project-v1" || !event.newValue) return;
      try {
        const incoming = JSON.parse(event.newValue) as PersistedEnvelope;
        if (incoming.tabId !== TAB_ID && incoming.revision > revision()) setConflict(incoming);
      } catch {
        // Ignore unrelated or malformed storage events.
      }
    };
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches("input, textarea, select, [contenteditable='true']");
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        const envelope = saveProject(project(), revision(), TAB_ID);
        setSaveStatus("saved");
        setLastAction("已保存本地草稿");
        channel?.postMessage(envelope);
        return;
      }
      if (editing) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        mergeWithNext();
      } else if (event.key.toLowerCase() === "r" && activeSegment()) {
        event.preventDefault();
        commitSegment("标记片段已校对", (segment) => { segment.reviewed = true; });
      } else if (event.key === "?" || (event.shiftKey && event.key === "/")) {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("storage", handleStorage);
    window.addEventListener("keydown", handleKeydown);
    setOnline(navigator.onLine);
    onCleanup(() => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("keydown", handleKeydown);
    });
  });

  channel?.addEventListener("message", (event: MessageEvent<PersistedEnvelope>) => {
    if (event.data.tabId !== TAB_ID && event.data.revision > revision()) setConflict(event.data);
  });

  createEffect(() => {
    const current = project();
    const currentRevision = revision();
    if (!hydrated) return;
    setSaveStatus(online() ? "saving" : "offline");
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const envelope = saveProject(current, currentRevision, TAB_ID);
      setSaveStatus(online() ? "saved" : "offline");
      if (dirty) {
        channel?.postMessage(envelope);
        dirty = false;
      }
    }, 420);
  });

  onCleanup(() => {
    window.clearTimeout(saveTimer);
    channel?.close();
  });

  const clickSegment = (id: string) => {
    setSelectedId(id);
    queueMicrotask(() => editorRef?.focus());
  };

  return (
    <div class="app-shell">
      <Show when={conflict()}>
        {(incoming) => (
          <div class="conflict-banner" role="alert">
            <div>
              <strong>检测到另一个标签页修改了同一草稿</strong>
              <span>
                对方版本保存于 {new Date(incoming().savedAt).toLocaleTimeString()}。为避免静默覆盖，请选择要保留的版本。
              </span>
            </div>
            <div class="conflict-actions">
              <button class="btn btn-quiet" onClick={() => resolveConflict(false)}>保留本页</button>
              <button class="btn btn-danger" onClick={() => resolveConflict(true)}>载入对方版本</button>
            </div>
          </div>
        )}
      </Show>

      <header class="topbar">
        <div class="brand-mark" aria-hidden="true"><span>口述</span><b>1007</b></div>
        <div class="project-heading">
          <input
            aria-label="项目标题"
            value={project().title}
            onChange={(event) => commit("修改项目标题", (draft) => { draft.title = event.currentTarget.value; })}
          />
          <div class="project-meta">
            <span>{project().interviewee}</span>
            <span>{project().recordingDate}</span>
            <span class={`save-state ${saveStatus()}`}>{statusText(saveStatus())}</span>
          </div>
        </div>
        <div class="top-actions">
          <span class={`network-chip ${online() ? "online" : "offline"}`}>{online() ? "在线" : "离线可编辑"}</span>
          <button class="icon-btn" title="撤销 Ctrl/Cmd+Z" disabled={!past().length} onClick={undo}>↶</button>
          <button class="icon-btn" title="重做 Ctrl/Cmd+Shift+Z" disabled={!future().length} onClick={redo}>↷</button>
          <button class="btn btn-quiet" onClick={() => setHelpOpen(true)}>快捷键 <kbd>?</kbd></button>
          <button class="btn btn-primary" onClick={exportSrt}>导出 SRT</button>
        </div>
      </header>

      <div class="workspace">
        <aside class="left-panel">
          <section class="panel-section overview-card">
            <div class="eyebrow">校对进度</div>
            <div class="progress-row">
              <strong>{completedPercent()}%</strong>
              <span>{project().tracks.flatMap((track) => track.segments).filter((segment) => segment.reviewed).length} / {project().tracks.flatMap((track) => track.segments).length} 片段</span>
            </div>
            <div class="progress-track"><i style={{ width: `${completedPercent()}%` }} /></div>
            <p>修改会自动保存在本机；断网后仍可继续校对。</p>
          </section>

          <section class="panel-section">
            <div class="section-title"><h2>文本轨道</h2><span>{project().tracks.length}</span></div>
            <div class="track-list">
              <For each={project().tracks}>
                {(track) => (
                  <button class={`track-card ${track.id === project().activeTrackId ? "active" : ""}`} onClick={() => switchTrack(track.id)}>
                    <span class="track-icon">{track.language === "English" ? "EN" : track.language === "福州话转写" ? "方" : "普"}</span>
                    <span class="track-info"><strong>{track.name}</strong><small>{track.segments.length} 段 · {track.status}</small></span>
                    <span class="track-dot" style={{ background: track.status === "已完成" ? "#15803d" : track.status === "校对中" ? "#d97706" : "#94a3b8" }} />
                  </button>
                )}
              </For>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".srt,.txt,.vtt"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importFile(file);
                event.currentTarget.value = "";
              }}
            />
            <button class="wide-action" onClick={() => fileInputRef?.click()}><span>＋</span> 导入带时间码文本</button>
            <div class="hint">支持 SRT / VTT / 每行 `[00:12] 文本`</div>
          </section>

          <section class="panel-section tag-summary">
            <div class="section-title"><h2>标注实体</h2><span>{project().tags.length}</span></div>
            <div class="legend">
              <span><i style={{ background: "#2563eb" }} />主题</span>
              <span><i style={{ background: "#b45309" }} />事件</span>
              <span><i style={{ background: "#be185d" }} />人物</span>
            </div>
            <p>在右侧“标注”页把当前片段关联到主题、事件和人物。</p>
          </section>
        </aside>

        <main class="transcript-panel">
          <div class="panel-toolbar">
            <div>
              <div class="eyebrow">当前轨道</div>
              <h1>{activeTrack().name}</h1>
            </div>
            <div class="filters" role="group" aria-label="片段筛选">
              <button class={trackFilter() === "all" ? "active" : ""} onClick={() => setTrackFilter("all")}>全部</button>
              <button class={trackFilter() === "unreviewed" ? "active" : ""} onClick={() => setTrackFilter("unreviewed")}>未校对</button>
              <button class={trackFilter() === "low" ? "active" : ""} onClick={() => setTrackFilter("low")}>低置信</button>
              <button class="glossary-trigger" onClick={() => { setGlossaryNotice(null); setGlossaryOpen(true); }}>
                词条校对<span>{trackHits().length}</span>
              </button>
            </div>
          </div>

          <div class="transcript-list" role="listbox" aria-label="转写片段">
            <For each={visibleSegments()}>
              {(segment, index) => (
                <article
                  id={`segment-${segment.id}`}
                  role="option"
                  aria-selected={segment.id === selectedId()}
                  class={`segment-card ${segment.id === selectedId() ? "selected" : ""} ${segment.reviewed ? "reviewed" : ""}`}
                  onClick={() => clickSegment(segment.id)}
                >
                  <div class="segment-rail" style={{ background: speakerById(segment.speakerId)?.color ?? "#64748b" }} />
                  <div class="segment-time">
                    <span>{formatTime(segment.start, false)}</span>
                    <small>{formatTime(segment.end, false)}</small>
                  </div>
                  <div class="segment-body">
                    <div class="segment-meta">
                      <b>{speakerById(segment.speakerId)?.name ?? "未知发言人"}</b>
                      <span class={`confidence c${segment.confidence}`}>置信 {segment.confidence}/5</span>
                      <Show when={segment.flags.lowConfidence}><span class="pill alert">低置信</span></Show>
                      <Show when={segment.flags.dialect}><span class="pill dialect">方言</span></Show>
                      <Show when={segment.flags.properNoun}><span class="pill proper">专名</span></Show>
                      <Show when={segment.reviewed}><span class="pill done">✓ 已校对</span></Show>
                    </div>
                    <p>{segment.text}</p>
                    <div class="segment-tags">
                      <For each={segment.tagIds.map(tagById).filter(Boolean)}>
                        {(tag) => <span style={{ "--tag-color": tag!.color } as any}>#{tag!.label}</span>}
                      </For>
                    </div>
                  </div>
                  <span class="segment-index">{index() + 1}</span>
                </article>
              )}
            </For>
            <Show when={!visibleSegments().length}>
              <div class="empty-state"><b>没有符合筛选条件的片段</b><span>切换到“全部”继续校对。</span></div>
            </Show>
          </div>
        </main>

        <aside class="inspector">
          <Show when={activeSegment()} fallback={<div class="empty-inspector"><b>选择一个片段</b><p>在中间列表点击片段后即可校正发言人、置信度、标记和批注。</p></div>}>
            {(segment) => (
              <Tabs defaultValue="correct" class="inspector-tabs">
                <Tabs.List class="tab-list">
                  <Tabs.Trigger value="correct">校对</Tabs.Trigger>
                  <Tabs.Trigger value="annotate">标注</Tabs.Trigger>
                  <Tabs.Trigger value="comments">批注 <span>{segment().comments.length}</span></Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="correct" class="tab-content">
                  <div class="inspector-heading">
                    <div><span>片段 {activeTrack().segments.findIndex((item) => item.id === segment().id) + 1}</span><strong>{formatTime(segment().start, false)} — {formatTime(segment().end, false)}</strong></div>
                    <button class={`review-button ${segment().reviewed ? "done" : ""}`} onClick={() => commitSegment("标记片段已校对", (item) => { item.reviewed = true; })}>
                      {segment().reviewed ? "✓ 已校对" : "标记已校对"}
                    </button>
                  </div>

                  <label class="field-label" for="speaker-select">发言人</label>
                  <select
                    id="speaker-select"
                    value={segment().speakerId}
                    onChange={(event) => commitSegment("校正发言人", (item) => { item.speakerId = event.currentTarget.value; item.reviewed = false; })}
                  >
                    <For each={project().speakers}>{(speaker) => <option value={speaker.id}>{speaker.name} · {speaker.role}</option>}</For>
                  </select>

                  <div class="time-grid">
                    <label>开始<input type="text" value={formatTime(segment().start)} onChange={(event) => commitSegment("修改开始时间", (item) => { item.start = parseTime(event.currentTarget.value); })} /></label>
                    <label>结束<input type="text" value={formatTime(segment().end)} onChange={(event) => commitSegment("修改结束时间", (item) => { item.end = parseTime(event.currentTarget.value); })} /></label>
                  </div>

                  <label class="field-label" for="transcript-editor">转写文本</label>
                  <textarea
                    id="transcript-editor"
                    ref={editorRef}
                    rows="7"
                    value={segment().text}
                    onChange={(event) => commitSegment("校正转写文本", (item) => { item.text = event.currentTarget.value; item.reviewed = false; })}
                  />
                  <div class="textarea-help">光标停在句中后点击“拆分”，系统会保留两侧时间码比例。</div>

                  <div class="field-label">置信度</div>
                  <div class="confidence-picker" role="radiogroup" aria-label="置信度">
                    <For each={[1, 2, 3, 4, 5] as Confidence[]}>
                      {(value) => <button class={segment().confidence === value ? "active" : ""} onClick={() => setConfidence(value)}>{value}</button>}
                    </For>
                  </div>

                  <div class="field-label">校对标记</div>
                  <div class="flag-list">
                    <Checkbox checked={segment().flags.lowConfidence} onChange={() => toggleFlag("lowConfidence")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>低置信词或句</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.dialect} onChange={() => toggleFlag("dialect")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>方言表达</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.properNoun} onChange={() => toggleFlag("properNoun")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>专有名词</Checkbox.Label>
                    </Checkbox>
                  </div>

                  <div class="split-actions">
                    <button onClick={splitSelection}>⌁ 按光标拆分</button>
                    <button disabled={activeTrack().segments.at(-1)?.id === segment().id} onClick={mergeWithNext}>合 合并下一段</button>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="annotate" class="tab-content">
                  <div class="content-title"><h3>关联主题、事件与人物</h3><p>一个片段可关联多个实体，复核后颜色会显示在列表中。</p></div>
                  <For each={project().tags}>
                    {(tag) => (
                      <button class={`tag-option ${segment().tagIds.includes(tag.id) ? "selected" : ""}`} onClick={() => toggleTag(tag.id)}>
                        <i style={{ background: tag.color }} />
                        <span><strong>#{tag.label}</strong><small>{tag.type === "topic" ? "主题" : tag.type === "event" ? "事件" : "人物"}</small></span>
                        <b>{segment().tagIds.includes(tag.id) ? "✓" : "＋"}</b>
                      </button>
                    )}
                  </For>
                </Tabs.Content>

                <Tabs.Content value="comments" class="tab-content comments-content">
                  <div class="content-title"><h3>批注与回复</h3><p>批注不会改写原文，可保留校对依据并继续讨论。</p></div>
                  <div class="comment-compose">
                    <textarea rows="3" placeholder="记录读音、词义或专名依据…" value={commentDraft()} onInput={(event) => setCommentDraft(event.currentTarget.value)} />
                    <button class="btn btn-primary" onClick={addComment}>添加批注</button>
                  </div>
                  <For each={segment().comments} fallback={<div class="mini-empty">当前片段还没有批注。</div>}>
                    {(comment) => (
                      <article class={`comment-card ${comment.resolved ? "resolved" : ""}`}>
                        <header><strong>{comment.author}</strong><time>{new Date(comment.createdAt).toLocaleString()}</time></header>
                        <p>{comment.body}</p>
                        <For each={comment.replies}>
                          {(reply) => <div class="reply"><b>{reply.author}</b><span>{reply.body}</span></div>}
                        </For>
                        <div class="reply-row">
                          <input
                            value={replyDrafts()[comment.id] ?? ""}
                            placeholder="回复…"
                            onInput={(event) => setReplyDrafts((drafts) => ({ ...drafts, [comment.id]: event.currentTarget.value }))}
                            onKeyDown={(event) => { if (event.key === "Enter") addReply(comment.id); }}
                          />
                          <button onClick={() => addReply(comment.id)}>回复</button>
                        </div>
                        <button class="resolve-link" onClick={() => toggleComment(comment.id)}>{comment.resolved ? "重新打开" : "标记已解决"}</button>
                      </article>
                    )}
                  </For>
                </Tabs.Content>
              </Tabs>
            )}
          </Show>
        </aside>
      </div>

      <footer class="statusbar">
        <span>最近操作：{lastAction()}</span>
        <span>版本 {revision() + 1} · 本地草稿</span>
        <span class="status-shortcuts">J/K 浏览　R 已校对　M 合并　? 帮助</span>
      </footer>

      <Dialog open={helpOpen()} onOpenChange={setHelpOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content">
            <Dialog.Title>键盘校对</Dialog.Title>
            <Dialog.Description>光标在输入框中时，单键快捷键不会抢占文字输入。</Dialog.Description>
            <div class="shortcut-grid">
              <span><kbd>J</kbd><kbd>↓</kbd> 下一片段</span>
              <span><kbd>K</kbd><kbd>↑</kbd> 上一片段</span>
              <span><kbd>R</kbd> 标记已校对</span>
              <span><kbd>M</kbd> 合并下一片段</span>
              <span><kbd>Ctrl/⌘ Z</kbd> 撤销</span>
              <span><kbd>Ctrl/⌘ ⇧ Z</kbd> 重做</span>
              <span><kbd>Ctrl/⌘ S</kbd> 立即保存</span>
              <span><kbd>?</kbd> 显示本帮助</span>
            </div>
            <div class="dialog-footer"><button class="btn btn-primary" onClick={() => setHelpOpen(false)}>开始校对</button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      <Dialog open={glossaryOpen()} onOpenChange={setGlossaryOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content glossary-dialog">
            <Dialog.Title>词条校对</Dialog.Title>
            <Dialog.Description>
              把同一专名的错写法和规范写法登记成一对；下方只列出「{activeTrack().name}」中仍能命中的片段。
            </Dialog.Description>

            <div class="glossary-add">
              <input
                aria-label="错写法"
                placeholder="错写法，如：林友德"
                value={entryFrom()}
                onInput={(event) => setEntryFrom(event.currentTarget.value)}
                onKeyDown={(event) => { if (event.key === "Enter") addGlossaryEntry(); }}
              />
              <span class="glossary-arrow" aria-hidden="true">→</span>
              <input
                aria-label="规范写法"
                placeholder="规范写法，如：林有德"
                value={entryTo()}
                onInput={(event) => setEntryTo(event.currentTarget.value)}
                onKeyDown={(event) => { if (event.key === "Enter") addGlossaryEntry(); }}
              />
              <button class="btn btn-primary" onClick={addGlossaryEntry}>登记</button>
            </div>

            <Show when={glossaryNotice()}>
              {(notice) => <div class={`glossary-notice ${notice().kind}`} role="status">{notice().text}</div>}
            </Show>

            <For each={glossaryChains()}>
              {(chain) => (
                <div class="glossary-notice warn" role="alert">
                  词条链式提醒：「{chain.first.from} → {chain.first.to}」的规范写法「{chain.first.to}」又是另一条词条「{chain.next.from} → {chain.next.to}」的错写法；对前者应用时会停下，请人工裁决这两条。
                </div>
              )}
            </For>

            <div class="glossary-entry-list">
              <div class="glossary-subhead">已登记词条 <span>{project().glossary.length}</span></div>
              <Show when={project().glossary.length} fallback={<div class="glossary-empty">还没有词条，先在上方登记第一对写法。</div>}>
                <For each={glossaryEntries()}>
                  {(entry) => (
                    <div class="glossary-entry">
                      <span class="glossary-pair">
                        <b>{entry.from}</b>
                        <i>→</i>
                        <b>{entry.to}</b>
                      </span>
                      <span class="glossary-entry-count">本轨道 {entryHitTotal(entry.id)} 处</span>
                      <button class="glossary-remove" title="删除词条" onClick={() => removeGlossaryEntry(entry)}>✕</button>
                    </div>
                  )}
                </For>
              </Show>
            </div>

            <div class="glossary-hits">
              <div class="glossary-subhead">当前轨道命中片段 <span>{trackHits().length}</span></div>
              <Show when={trackHits().length} fallback={<div class="glossary-empty">当前轨道没有能命中的片段。</div>}>
                <For each={trackHits()}>
                  {(hit) => {
                    const index = () => activeTrack().segments.findIndex((item) => item.id === hit.segment.id) + 1;
                    return (
                      <article class={`glossary-hit ${hit.segment.reviewed ? "reviewed" : ""}`}>
                        <header>
                          <button class="glossary-hit-jump" onClick={() => { setSelectedId(hit.segment.id); setGlossaryOpen(false); }}>
                            第 {index()} 段 · 命中 {hit.total} 处
                          </button>
                          <Show when={hit.segment.reviewed}><span class="pill done">原为已校对</span></Show>
                        </header>
                        <p>
                          <For each={highlightParts(hit.segment.text)}>
                            {(part) => (
                              <Show when={part.hit} fallback={<span>{part.text}</span>}>
                                {(entry) => <mark class="glossary-mark">{part.text}<small>{entry().to}</small></mark>}
                              </Show>
                            )}
                          </For>
                        </p>
                        <div class="glossary-apply-row">
                          <For each={[...hit.perEntry.keys()].map(entryById).filter(Boolean) as GlossaryEntry[]}>
                            {(entry) => {
                              const chained = () => chainBlockingEntry(entry, project().glossary);
                              return (
                                <button
                                  class="glossary-apply"
                                  disabled={!!chained()}
                                  title={chained() ? `规范写法「${entry.to}」是另一条词条的错写法，已拦下` : `把本段所有「${entry.from}」改为「${entry.to}」`}
                                  onClick={() => applyGlossaryEntry(hit.segment.id, entry)}
                                >
                                  应用「{entry.from} → {entry.to}」×{hit.perEntry.get(entry.id)}
                                </button>
                              );
                            }}
                          </For>
                        </div>
                      </article>
                    );
                  }}
                </For>
              </Show>
            </div>

            <div class="dialog-footer">
              <button class="btn btn-quiet" onClick={() => setGlossaryOpen(false)}>完成</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  );
}
