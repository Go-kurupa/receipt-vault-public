# 開発者向けガイド：構成と確認手順

[作品のREADMEへ戻る](../README.md)

## 前提

- Node.js 22とnpm。Cloud FunctionsとMCPサーバーのpackage.jsonがNode.js 22を指定しています。
- 依存関係はルート、functions、mcpの3か所で管理しています。それぞれにpackage-lock.jsonを収録しています。
- 本番のデータベース、領収書画像、認証・配備設定、ビルド成果物は同梱していません。

## 構成

| 場所 | 役割 | 読み始める実装 |
|---|---|---|
| src/ | React・TypeScriptの画面 | [画面のソース](../src/) |
| functions/ | 訂正の版管理、要求の重複防止 | [版管理](../functions/src/versioning.ts)、[重複防止](../functions/src/idempotency.ts) |
| mcp/ | 会話からの検索・集計・整理、認証・権限 | [整理の処理](../mcp/src/write/tools.ts) |
| docs/ | このコピーの開発・確認手順 | このガイド |

## 依存関係を入れる

このリポジトリのルートで実行します。

```bash
npm ci
npm ci --prefix functions
npm ci --prefix mcp
```

## テストとビルド・型検査

```bash
npm test
npm test --prefix functions
npm test --prefix mcp

npm run build
npm run build --prefix functions
npm run typecheck --prefix mcp
```

3つのtestスクリプトは、いずれも一度実行して終了する `vitest run` です。
画面のbuildはTypeScriptの検査とViteのビルド、functionsのbuildはTypeScriptのコンパイル、mcpのtypecheckは出力ファイルを作らない型検査です。

これらは収録したpackage.jsonに対応するコマンドです。2026-10-26の文書改訂では、アプリのテスト・ビルドは再実行していません。
過去の通過記録は[README](../README.md)に記載しています。

## アプリ全体を利用する場合

Firebaseの認証、データベース、保存先と、MCPサーバーを呼び出すための接続・権限設定が必要です。
画面用の設定項目は `.env.example` にダミー値のテンプレートとして収録しています。実用の値は自分の環境に設定します。
設定ファイルは、このコピーをそのまま実運用へ配備できることを示すものではありません。

本番への配備・接続やデータ変更は、この資料の確認手順には含めていません。
