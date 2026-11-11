# fantasy(AESPA 日報)

Leo 的 ESPN NBA fantasy 聯盟(TPBL,10 隊,H2H Points,2026-27 季,leagueId 406470928,season 2027,隊名用 `'aespa'` 比對)的自動戰報網站。正式版:https://leo976810.github.io/fantasy/v2/ 。詳細歷史、舊 bug 與機制細節在 `docs/HISTORY.md`,需要時才讀。

## 檔案與資料流

- GitHub Actions(`.github/workflows/update.yml`,排程 + push `data.json`/`*.mjs` 觸發):`gate.mjs` → `update.mjs` → `build.mjs` → `brief.mjs`,再由 bot commit `data.json`、`v2/index.html`、`brief.json`。
- `update.mjs`:ESPN 數字 → `data.json`(戰績、對戰、陣容與評語、賽程 `sched`、傷兵 `injuries`、`autoAsof`)。
- `build.mjs`:`data.json` 的白名單欄位(`OVER`)疊到 `v2/index.html` 嵌入資料,再算衍生欄位:streaming 試算、增補建議 `picks/pickNote`、異動說明 `acqNote`、潛力發掘 `sleepers`、陣容檢查 `fridayLineup`、傷病說明 `rosterExtra` 等。新欄位要給前端用,記得加進 `OVER`。
- `brief.mjs`:從網站資料切出約 4 KB 的 `brief.json`(含 `staleSections`)。
- `apply-hand.mjs hand.json`:把每日手寫判斷(`todo`、`threads`)套進 `data.json`,並更新 `handAsof` 與 `asof`。
- 根目錄 `index.html` 是凍結的 v1,**永遠不要動它**;只改 `v2/index.html` 與上面的腳本。

## 資料一致性規則

- 只有 `todo` 和 `threads` 是手寫,各有 `handAsof` 撰寫日期;網站會在過期的手寫內容旁標日期。其他區塊全部由程式每次重算,要改內容就改程式,不要手改 `data.json`。
- `#recap` 會被「今天的比賽」即時小工具取代,不用寫 `recap`。
- 自動待辦(前端產生)已經涵蓋:先發調整、傷兵先發、增補首選、本週局勢、背靠背。手寫 `todo` 只寫這些沒有涵蓋的策略判斷。

## 每日更新(省 token)

用 `/daily` 技能,**每天開新對話**做完就結束。只讀 `brief.json`,不要整份讀 `data.json`(約 80 KB)或 `v2/index.html`(約 350 KB);需要細節時用 node 或 grep 只取特定欄位。改程式用局部編輯,不要整份重寫。

## 聯盟規則

- 陣容:PG、SG、SF、PF、C、G、F、3 UTIL、3 板凳、2 IR;每日鎖陣容;有 waivers(24 小時)。
- 每個比賽日最多加 1 人(ESPN `matchupAcquisitionLimit` 1、`matchupLimitPerScoringPeriod`)。
- **C 資格整隊最多 4 人**(其他位置無上限);streaming 試算已遵守。
- 計分:PTS 1、FGM 2、FGA -1、FTM 1、FTA -1、3PM 2、3PA -1、OREB 1、REB 1、AST 2、STL 4、BLK 4、TO -2、PF -1、QD 20、Team Win 2。
- 評估球員要合併上季與本季,roster% 只當輔助。

## 工作規則

1. 純後端/資料修正可以直接 push `main`;push 後一定要對照 ESPN 或正式網站驗證才算完成。
2. 會改到畫面(版面、文字、樣式、新功能)先讓 Leo 看過再 push `main`(push 會立刻觸發 Actions 上線)。
3. 每個版本要更新 `data.json` 的 `version` 與 `changelog`(目前 v2.31)。
4. **絕對不要記住、輸入或使用 Leo 的 ESPN 密碼**;聯盟已公開,不需要登入。
5. 查不到的資料(Reddit、Threads 搜尋等)要明說,不要假裝有查到。
6. 用繁體中文溝通。Leo 用 iPhone,常傳截圖。
