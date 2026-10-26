# Autocord v0.1

日本語のSlash Commandからロールパネルの計画を作成し、管理者プレビューの承認後にDiscordへ反映するMVPです。自然言語を解釈するAgentは計画JSONのみを返し、権限検査とDiscord API操作はアプリケーション層で行います。

## 起動

1. Node.js 22以上とDocker Composeを用意し、`cp .env.example .env` 後にDiscord Bot token、Application ID、OpenCode ZenのOpenAI互換APIキーを設定。
2. `docker compose up -d postgres`
3. `npm install && npm run db:migrate`
4. `npm run commands:deploy`
5. `npm run dev`

BotにはGuilds、Guild Members intentと、ロール管理・メッセージ送信・メッセージ履歴の権限を付与します。Botのロールを作成対象ロールより上位に配置してください。

## MVPの操作

- `/agent 指示: MinecraftとVALORANTのロールパネルを作って` で計画を生成します。
- 生成された公開プレビューの「承認して実行」を管理権限ユーザーが押すと、ロール作成とパネル発行を行います。
- `/agent 指示: <既存パネル名>を紫色にして` のような編集には、既存パネルを指定するUIが未実装です。現在のPlannerは作成計画が中心であり、パネル一覧からの選択・既存状態取得を次の実装項目とします。
- パネル選択はLLMを経由せず、DBに保存されたrole bindingからロールを付け外しします。

## 現時点の制約

この初回縦切りは実装土台です。承認にplan hash・guild・有効期限を紐付け、実行時にも権限を再確認します。複数Discord API操作とDB更新をまたぐ完全な補償トランザクション、ギルド単位のキュー直列化、利用量上限、編集時の古いロール整理は未実装です。公開ベータ前に追加してください。

`npm test`、`npm run typecheck`、`npm run build` でローカル検証できます。
