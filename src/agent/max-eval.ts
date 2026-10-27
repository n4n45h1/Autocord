import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { makePlan } from "./planner.js";
import type { PlanResult } from "./planner.js";

type Expectation = "should_plan" | "must_clarify" | "either_valid";
type EvalCase = { id: string; family: string; expectation: Expectation; prompt: string; requiredActions?: string[]; requiredTriggers?: string[] };
type EvalResult = {
  id: string;
  family: string;
  expectation: Expectation;
  pass: boolean;
  actual: "interactive" | "resources" | "panel" | "clarification" | "error";
  elapsedMs: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  actions?: string[];
  triggers?: string[];
  workflowGraph?: unknown;
  missingSkills?: string[];
  questions?: string[];
  diagnostics?: PlanResult["diagnostics"];
  error?: string;
};

const noise = [
  "",
  "えっと、急ぎでお願いします。",
  "できれば余計な機能は足さず、要件どおりに。",
  "ざっくりでいいけど、条件は落とさないで。",
  "日本語で短く書きます。",
  "プレビューで副作用が分かる形にしてください。",
  "ボタン名や文章は自然な日本語で。",
  "なお、既存の挙動は壊さないでください。",
  "同時操作や連打でも条件を守ってください。",
  "曖昧な部分は安全に補完せず確認してください。",
];

function makeCases(): EvalCase[] {
  const cases: EvalCase[] = [];
  const addFamily = (family: string, expectation: Expectation, bases: string[], requiredActions: string[] = [], requiredTriggers: string[] = []) => {
    for (let index = 0; index < 10; index++) {
      const base = bases[index % bases.length]!;
      const prefix = noise[index]!;
      const suffix = index % 2 ? "まず要件を整理して、承認プレビューまで出してください。" : "別機能への置き換えはしないでください。";
      cases.push({ id: `${family}-${String(index + 1).padStart(2, "0")}`, family, expectation, prompt: `${prefix}${prefix ? " " : ""}${base}${index % 3 === 0 ? ` ${suffix}` : ""}`, ...(requiredActions.length ? { requiredActions } : {}), ...(requiredTriggers.length ? { requiredTriggers } : {}) });
    }
  };

  addFamily("points", "should_plan", [
    "イベント参加ボタンで初回参加だけ100ポイント加算。500ポイント以上なら交換ボタンで500ポイントを原子的に引き落とし、成功時だけ本人に景品交換完了DM。",
    "参加登録が新規のときmember pointsを100増やす。ポイント500以上で景品交換、同時クリックでも負残高にせず、成功時だけ本人にDM。",
    "参加と同時に100pt、500ptで景品交換完了DM。重複参加の加算なし、引落しの閾値判定と減算をDB上で原子的に行う。",
    "100ポイントのイベント参加報酬と、残高500以上で500ポイント消費する交換ボタンを作って。交換成功したときだけDM通知。",
    "イベントの一意参加を確認してmemberのpointsに100加算、500以上を確認して500を原子的にdebitして交換完了DM。二重クリックで報酬重複や負残高を起こさない。",
  ], ["entry.join", "state.increment", "state.debit", "message.dm"], ["button"]);

  addFamily("ticket", "should_plan", [
    "問い合わせModalからstaff-only ticket channelを作成して回答をそこへ送信。staffRoleId=22345678901234567。投稿者と設定済みSupportスタッフが閉じられるようにする。",
    "問い合わせボタンでModalを開き、回答をStaffロールだけが見られる専用チャンネルに保存。Support role IDは22345678901234567、スタッフはticket IDを入力して閉じる。",
    "問い合わせフォーム回答から投稿者ごとにstaff_onlyのticketを作る。staffRoleId 22345678901234567だけ閲覧可能。本人とSupport担当が閉じられること。",
    "問い合わせ内容を公開せず、Modal送信時にSupport専用チャンネルを作成する。SupportのRole IDは22345678901234567。解決後はスタッフが閉鎖。",
    "ボタン→問い合わせフォーム→Support限定チャンネル。回答はそのチャンネルだけに送り、Support ID 22345678901234567を閲覧許可。staff closeも用意。",
  ], ["channel.create_text", "state.set", "message.send", "channel.delete"], ["modal_submit"]);

  addFamily("voice-lobby", "should_plan", [
    "Voice LobbyにVALORANT参加者が5人集まったら専用VCを作り、そのLobby参加者を移動。空になったらWorkflow所有VCだけ消す。",
    "既存ボイスLobby 12345678901234567に5人入ったらチームVCを生成して移動し、最後の人が抜けたときだけ自動削除。",
    "5名のVoice Lobby入室でゲームVCを作成、参加者を移し、無人なら作ったVCだけ片付ける。",
    "VALORANT用VoiceState募集。Lobby ID 12345678901234567、閾値5、空室時に作成したVoice Channelを削除。",
    "声チャンネルに5人集合で一時VCを作る。既存セッションを二重作成せず、Lobbyと一時VCの入退室を区別する。",
  ], ["voice.channel.create", "voice.channel.delete"], ["voice.member_join_event", "voice.member_leave_event"]);

  addFamily("reaction-vote", "should_plan", [
    "提案投稿ボタンがWorkflow-owned messageを作成。そのメッセージの👍が新規20票に初到達した時、message.send delivery=workflow_owner_dmでownerに一度だけ通知。1人1票。",
    "提案メッセージに対する👍をmessage単位で一人一つ記録し、20票ちょうどに達した瞬間だけWorkflow ownerへDM。通知後も投票は続ける。",
    "ボタンで提案を投稿、👍リアクション投票を数える。ユニーク投票者が20人に初到達した時だけWorkflow owner DM。",
    "reaction.addedで投稿ごとの投票CollectionへUser IDを追加、重複追加なし。初回の20票到達時だけmessage.send delivery=workflow_owner_dmでownerへ通知。",
    "提案ごとに一人一票。賛成👍が20票に初到達したら一度だけWorkflow ownerへDM。Workflowが作った提案Messageだけを対象にし、通知後も受付を続ける。",
  ], ["message.send", "collection.add", "collection.count"], ["button", "reaction.added"]);

  addFamily("weekly-missing-time", "must_clarify", [
    "毎週土曜日にイベントして受付開始、終わったらランキングをリセット。",
    "土曜ごとにイベントを立ち上げ、終了後に順位を初期化。",
    "毎週の土曜日に受付開始、イベント後に参加ランキングを消して。",
    "Saturday weekly eventを開催して、終わったあとleaderboard reset。",
    "毎週土曜イベント。開始して参加者を集めて終了後に順位をリセットする。",
  ]);

  addFamily("rpg-unsupported", "must_clarify", [
    "戦士、魔法使い、僧侶のRPG。HP、攻撃力、経験値、レベル、ゴールド、戦闘とショップを全部作って。",
    "Discordにターン制RPGを作成。職業選択、戦闘ループとショップ購入、経験値/レベルを実装。",
    "RPG風の戦闘とゴールドショップ。敵を何度も殴れるようにして。",
    "戦士と魔法使いで冒険し、HPが尽きたら敗北、経験値とGoldをもらい、ショップで買う仕組み。",
    "RPGの全機能を作って。クラス・攻撃・回復・レベルアップ・アイテム販売まで。",
  ]);

  addFamily("button-voice-unsupported", "must_clarify", [
    "募集ボタンで5人集まったら、その5人全員を専用VCに自動移動して、空いたら削除。",
    "5人が参加ボタンを押した時点でVCを作ってボタン参加者を入室させる。",
    "VC Lobbyではなく募集ボタンの人数を数えて、登録した5人をVoice Channelへ動かす。",
    "参加を押した5人だけのVoice roomを作り、他のLobby参加者を混ぜない。",
    "ボタンの参加者一覧から全員を拾ってVCへ移動し、退室イベントで片付けて。",
  ]);

  addFamily("schedule-missing-detail", "must_clarify", [
    "毎週土曜日18時にイベントを始めて、イベントが終わったら2時間後にランキングをreset。",
    "毎週土曜に受付開始。終了後にランキングをリセット、時間は適当に。",
    "Saturday at 18:00 JSTでイベント、終わったらランキングをリセットして。",
    "毎週土曜日にイベント開催。TimezoneはAsia/Tokyoだけど終了時間はまだ決めてない。",
    "土曜18:00 UTCに開始して、イベント終了後に参加者ランキングを消す。",
  ]);

  addFamily("state-changed-unsupported", "must_clarify", [
    "ポイント残高が変わった瞬間に別Workflowを起動するstate.changed triggerがほしい。",
    "state.changedイベントでMember stateの更新を購読し、変更前後の値を通知。",
    "Stateの値が更新されたら自動で反応するTriggerを追加して。",
    "Listen to state.changed and run a second automation whenever any scoped value changes.",
    "workflow stateが変化したときにchange eventを発火して再帰的に更新する仕組み。",
  ]);

  addFamily("messy-combined", "either_valid", [
    "えっと、参加100ptと500pt交換、それから投票も20で通知、問い合わせもStaffだけで、VCは5人で…全部まとめて。",
    "上の話ぜんぶいい感じに、細かいところは任せるけど勝手な機能は増やさないで。",
    "pointsとticketを作成。message contentとpublic panelに出して、staff-onlyにもして。",
    "毎週土曜18時UTC、終了時間不明だけどイベントとRPGショップを完全実装して。",
    "ボタン参加者5人をVCへ移動。ただしLobby参加者で判定し、ボタン参加者は数えない。",
  ]);
  return cases;
}

function classify(result: PlanResult): EvalResult["actual"] {
  if (result.clarification) return "clarification";
  if (result.interactiveWorkflow) return "interactive";
  if (result.resourceSteps) return "resources";
  if (result.workflowSteps) return "panel";
  if (result.plan) return "panel";
  return "clarification";
}

function evaluateOne(testCase: EvalCase, result: PlanResult, elapsedMs: number): EvalResult {
  const actual = classify(result);
  const actions = result.interactiveWorkflow?.triggers.flatMap((trigger) => trigger.steps.map((step) => step.action)) ?? [];
  const triggers = result.interactiveWorkflow?.triggers.map((trigger) => trigger.event) ?? [];
  const workflowGraph = result.interactiveWorkflow ? result.interactiveWorkflow.triggers.map((trigger) => ({
    id: trigger.id, event: trigger.event, componentKey: "componentKey" in trigger ? trigger.componentKey : undefined,
    steps: trigger.steps.map((step) => ({ id: step.id, action: step.action, dependsOn: step.dependsOn, when: step.when, parameters: Object.fromEntries(Object.entries(step).filter(([key]) => !["id", "action", "dependsOn", "when"].includes(key))) })),
  })) : result.resourceSteps ? result.resourceSteps.map((step) => ({ id: step.id, action: step.action, dependsOn: step.dependsOn })) : result.workflowSteps?.map((step) => ({ id: step.id, action: step.action, dependsOn: step.dependsOn }));
  const actionSet = new Set<string>(actions);
  const triggerSet = new Set<string>(triggers);
  let pass = actual !== "error";
  if (testCase.expectation === "should_plan") pass &&= actual === "interactive";
  if (testCase.expectation === "must_clarify") pass &&= actual === "clarification";
  if (testCase.requiredActions) pass &&= testCase.requiredActions.every((action) => actionSet.has(action));
  if (testCase.requiredTriggers) pass &&= testCase.requiredTriggers.every((trigger) => triggerSet.has(trigger));
  return {
    id: testCase.id, family: testCase.family, expectation: testCase.expectation, pass, actual, elapsedMs,
    model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
    actions, triggers, workflowGraph, missingSkills: result.clarification?.missingSkills, questions: result.clarification?.questions,
    diagnostics: result.diagnostics,
  };
}

async function main(): Promise<void> {
  const cases = makeCases();
  if (cases.length !== 100) throw new Error(`Expected 100 evaluation prompts, got ${cases.length}`);
  const outputPath = resolve(process.argv[2] ?? "reports/max-eval-100.jsonl");
  const offset = Math.max(0, Number(process.argv[3] ?? 0));
  const limit = Math.max(1, Math.min(100, Number(process.argv[4] ?? 100)));
  const selectedCases = cases.slice(offset, offset + limit);
  if (!selectedCases.length) throw new Error(`No evaluation cases at offset ${offset}.`);
  const concurrency = Math.max(1, Math.min(5, Number(process.env.MAX_EVAL_CONCURRENCY ?? 2)));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, "", "utf8");
  const results: EvalResult[] = new Array(selectedCases.length);
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = next++;
      if (index >= selectedCases.length) return;
      const testCase = selectedCases[index]!;
      const started = performance.now();
      try {
        const result = await makePlan(testCase.prompt, undefined, "max", undefined, [], [{ id: "12345678901234567", name: "Voice Lobby", category: "Games" }], [{ id: "22345678901234567", name: "Support" }]);
        results[index] = evaluateOne(testCase, result, Math.round(performance.now() - started));
      } catch (error) {
        results[index] = { id: testCase.id, family: testCase.family, expectation: testCase.expectation, pass: false, actual: "error", elapsedMs: Math.round(performance.now() - started), error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
      }
      await appendFile(outputPath, `${JSON.stringify({ prompt: testCase.prompt, ...results[index] })}\n`, "utf8");
      process.stdout.write(`${String(offset + index + 1).padStart(3, "0")}/100 ${testCase.id} ${results[index]!.actual} ${results[index]!.pass ? "PASS" : "FAIL"}\n`);
    }
  });
  await Promise.all(workers);
  const byFamily = new Map<string, EvalResult[]>();
  for (const result of results) (byFamily.get(result.family) ?? (byFamily.set(result.family, []), byFamily.get(result.family)!)).push(result);
  const summary = Object.fromEntries([...byFamily].map(([family, rows]) => [family, { total: rows.length, passed: rows.filter((row) => row.pass).length, clarification: rows.filter((row) => row.actual === "clarification").length, errors: rows.filter((row) => row.actual === "error").length }]));
  const durations = results.map((result) => result.elapsedMs).sort((a, b) => a - b);
  const report = { createdAt: new Date().toISOString(), model: process.env.AGENTCORD_MAX_MODEL ?? process.env.OPENCODE_MODEL_MAX ?? "river/deepseek-v4.1-flash", backend: process.env.AI_BACKEND ?? "opencode-server", concurrency, offset, cases: selectedCases.length, passed: results.filter((result) => result.pass).length, failed: results.filter((result) => !result.pass).length, totalInputTokens: results.reduce((sum, result) => sum + (result.inputTokens ?? 0), 0), totalOutputTokens: results.reduce((sum, result) => sum + (result.outputTokens ?? 0), 0), p50LatencyMs: durations[Math.floor(durations.length * 0.50)], p95LatencyMs: durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)], byFamily: summary, log: outputPath };
  await writeFile(outputPath.replace(/\.jsonl$/, ".summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

await main();
