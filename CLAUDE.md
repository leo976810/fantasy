# fantasy(AESPA 日報)— 給 Claude Code 的專案交接文件

這份文件是從另一個 Claude(在 claude.ai 上,透過瀏覽器操作/網頁上傳的方式經營這個專案)交接給 Claude Code 的技術說明。目的是讓 Claude Code 不需要重新摸索,就能直接讀程式碼、改 bug、加功能。

## 這個專案是什麼

Leo 參加一個朋友間的 ESPN NBA fantasy 聯盟(TPBL,10 隊,Head to Head Points 計分,2026-27 賽季),他的隊名是 AESPA。這個 repo 產出一個**自動更新的每日戰報網站**(GitHub Pages),取代他每天手動刷 ESPN App、Threads、新聞的時間。核心是:每天自動從 ESPN 抓資料、生成分析(誰該先發、誰可以補強、對手在幹嘛),最終目標是幫 Leo 贏得聯盟冠軍。

- 網站(正式版):https://leo976810.github.io/fantasy/v2/
- Repo:leo976810/fantasy(GitHub Pages 設定為從 repo root 發布)
- ESPN 聯盟:leagueId **406470928**,season **2027**(對應 2026-27 賽季),Leo 的隊伍名稱在程式裡用 `'aespa'` 比對(不是數字 teamId,見下方 update.mjs 說明)

## 檔案結構與各檔案職責

```
/
├── index.html          # v1,已凍結成舊版快照 —— 絕對不要再自動更新或讓 pipeline 碰它
├── data.json           # 人工維護的「事實來源」:ESPN 數字 + Leo/Claude 手寫的判斷文字
├── update.mjs          # 從 ESPN API 抓最新數字,寫回 data.json(不碰手寫文字欄位)
├── build.mjs           # 把 data.json 疊到 v2/index.html 既有的嵌入資料上,重新產生 v2/index.html
├── gate.mjs             # 決定這次排程要不要真的跑 update+build(避免每 30 分跑好幾次無意義的全量更新)
├── brief.mjs            # build 之後從 v2/index.html 的嵌入資料切出 brief.json(不連網)
├── brief.json           # 約 4 KB 的精簡簡報,給 Claude 讀;和網站用同一份資料
├── README.md            # 目前幾乎是空的,沒有實質內容
└── v2/
    └── index.html       # 正式版網站,唯一允許自動更新的版本;嵌入一份 <script id="data" type="application/json"> 資料 blob
```

**資料流向(很重要,決定修 bug 時該改哪個檔案):**

1. `update.mjs` 讀 `data.json`,打 ESPN API(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027/segments/0/leagues/406470928`,還有 `proTeamSchedules_wl` 抓賽程),把數字欄位(`matchup`、`matchupDays`、`roster`、`record`、聯盟排名等)寫回 `data.json`。**不會動 `data.json` 裡的手寫判斷文字**(todo、threads、sleepers 的文字內容、picks 的理由等)——這些是 Leo 或 Claude 手動編輯的,update.mjs 只覆蓋數字類欄位。
2. `build.mjs` 讀 `v2/index.html` 裡嵌入的舊資料(當作基底 `A`),再讀 `data.json`(當作 `B`),用一份白名單(`OVER` 陣列,目前是 `['asof','league','record','matchup','recap','injuries','threads','roster','picks','pickNote','acqNote','sched','foot','stream','todo','sleepers','autoAsof','version','changelog']` 加上 `matchupDays` 特別處理)把 `B` 的欄位蓋到 `A` 上,然後額外打幾個 ESPN/ESPN site API 補一些「`A` 原生就有、`data.json` 沒有」的衍生欄位(傷病回歸日期、近期得分趨勢等),最後把合併後的 `A` 寫回 `v2/index.html` 的 `<script id="data">` blob 裡。
   - **白名單是個常見踩雷點**:如果之後在 `data.json` 加新欄位,但忘記把它加進 `build.mjs` 的 `OVER` 白名單,那個欄位永遠不會出現在網站上(`data.json` 裡有,但 `v2/index.html` 嵌入的資料裡沒有)。像 `lastWeekResult`、`matchupBase`、`burstWeek` 這幾個欄位就是故意沒放進白名單——它們是 `build.mjs` 內部用來跨次執行比對狀態的「暫存欄位」,不是給前端畫面用的,所以不需要也不應該出現在 `A`/`v2/index.html` 裡,只活在 `data.json`(`lastWeekResult`、`matchupBase`)或 `v2/index.html` 自己的 blob 裡(`burstWeek`——注意 `burstWeek` 完全不經過 `data.json`,是 `build.mjs` 自己讀寫在 `A` 裡的)。
3. `v2/index.html` 的前端 `<script>`(第二段,決策頁渲染邏輯那段)在瀏覽器端讀這包嵌入資料 `D`,算出各種衍生值(勝率預測 `T`、先發建議、傷病追蹤等)並寫進對應的 `<section id="...">` DOM。

**週報/連戰凍結機制(2026-11-09 才修好,之後改動要小心別重蹈覆轍):**
- `update.mjs` 用 `matchupBase`(目前對陣期的起始 scoring period 編號)而不是「對手名字有沒有變」來判斷是否換週了——之前用對手名字比對,遇到連續兩輪碰到同一個對手就會誤判沒換週。換週時會把上一週的比分凍結進 `data.json` 的 `lastWeekResult`。
- `build.mjs` 讀到 `B.lastWeekResult` 且偵測到 `burstWeek.base` 真的變了,才會把上週戰報(最終比分 + 當週爆走/爆胎排行)寫進 `A.weekReport`,前端的「上週戰報」區塊才會有內容。
- `matchupDays.dates`(每天對應的 MM/DD 顯示用字串)是 `update.mjs` 每次執行都用 `base` 重新算出來的(錨點:scoring period 14 = 2026/11/2,之後每 7 期往後推 7 天),不是凍結快照,所以理論上不會再卡在舊日期。

## 資料一致性規則(v2.29 起)

網站上每個區塊只能是下面兩種之一,不能「自動數字配手寫文字」:

- **全自動,每次執行都重算**:戰績、對戰、陣容數字與陣容評語(`update.mjs` 的 `tier`/`verdict`)、傷兵快報(`D.injuries`,ESPN 傷兵狀態 + 回歸日,涵蓋我隊與本週對手)、賽程場次(`D.sched`)、陣容裡的傷病說明(`rosterExtra.inj/note`)、Streaming 試算與說明(`streamPlan`),以及 `build.mjs` 其他衍生欄位。要改這些內容,改產生它的程式,不要手改 `data.json`。
- **手寫判斷,帶撰寫日期**:`todo`、`picks`/`pickNote`/`acqNote`、`threads`、`recap`、`sleepers`、`fridayLineup`。每個區塊在 `data.json` 的 `handAsof` 裡有自己的日期(`YYYY-MM-DD`,台北時間)。網站會在過了撰寫當天的區塊上標「X/X 寫的判斷」。**改寫任何一個手寫區塊時,一定要同時把 `handAsof` 對應的日期和 `asof` 更新成今天。**

頁首顯示兩個時間:「數字更新」= `autoAsof`(每次管線執行),「判斷撰寫」= `asof`(最後一次手寫)。

**省 token:** 要了解目前狀況時,先讀 `brief.json`(約 4 KB)。只有需要細節時才讀 `data.json` 的特定欄位,不要整份讀 `v2/index.html`(約 350 KB)。`brief.json` 的 `staleSections` 會列出哪些手寫區塊已經過期。改程式時用局部編輯,不要整份重寫檔案。

## 自動化管線(GitHub Actions,`.github/workflows/update.yml`)

```yaml
on:
  schedule: ['17,47 * * * *']   # 每小時的 :17 和 :47(= 大約每 30 分鐘一次)
  workflow_dispatch:             # 可以手動在 GitHub Actions 頁面觸發
  push:
    paths: ['data.json', 'build.mjs', 'update.mjs', 'gate.mjs']   # 這四個檔案一有新 commit 也會立刻跑一次
jobs:
  update:
    - node gate.mjs      # 決定要不要真的跑(輸出 run=true/false)
    - node update.mjs    # 只有 gate 說 true 才跑
    - node build.mjs     # 只有 gate 說 true 才跑
    - node brief.mjs     # 只有 gate 說 true 才跑
    - 用 github-actions bot 身份 commit + push data.json、v2/index.html 與 brief.json(如果真的有變動才 commit)
```

**`gate.mjs` 的邏輯**(避免每 30 分鐘都浪費 API quota 跑一次全量更新):只有在排程觸發(`schedule` 事件)才會檢查;手動 dispatch 或 push 觸發一定跑。排程觸發時,只有符合以下任一條件才真的跑 `update.mjs`/`build.mjs`:
- 「今天的計分日」跟上次記錄的 `data.json.doneSp`不一樣(代表今天的比賽剛結束,有新的一天資料要收)
- 現在剛好落在固定的 4 小時整點時段(`now.getUTCHours() % 4 === 1 && minutes < 30`,也就是 UTC 01:xx/05:xx/09:xx…,固定補一次全量更新)
- 偵測到有新的聯盟交易(add/drop/trade)自上次記錄的 `lastTxSeen` 之後發生——這是為了即時抓到對手臨時 streaming 補人,不用等到下一個 4 小時整點時段

**也就是說:這個網站的自動更新完全靠 GitHub Actions 排程,不依賴任何外部排程服務或 claude.ai 的 scheduled task。** 之前那個 Claude(claude.ai 這邊)另外設了幾個自己的排程任務(每日提醒、優化檢查),那些是「Leo 跟 claude.ai 上的 Claude 之間」的提醒/巡檢機制,跟這個 repo 本身的資料自動更新是兩條獨立的線——即使 claude.ai 那邊的排程任務都停掉,GitHub Actions 這條線還是會自己每 30 分鐘跑。

## 部署細節

- GitHub Pages 設定為從 `main` 分支 root 發布靜態檔案。
- `index.html`(root)= **v1,已凍結**,網址是 `https://leo976810.github.io/fantasy/`——這是舊版快照,**永遠不要自動更新它、也不要讓任何 pipeline 寫入它**。目前的 workflow 本身沒有碰它,之後也要維持這樣。
- `v2/index.html` = 正式運作中的版本,網址是 `https://leo976810.github.io/fantasy/v2/`,是 Leo 實際每天在看的網站,也是 `build.mjs` 唯一會寫入的 HTML。
- 沒有 build 工具鏈(沒有 bundler、沒有 npm 依賴)——`update.mjs`/`build.mjs`/`gate.mjs` 都是直接用 Node 20 原生 `fetch` 跑的單檔 ES module script,repo 裡沒有 `package.json`。

## 聯盟規則與計分(data.json 裡的手寫設定,改規則要連這裡一起改)

- ESPN NBA fantasy,聯盟名 TPBL,10 隊,Head to Head Points,2026-27 賽季,leagueId 406470928
- 陣容:PG、SG、SF、PF、C、G、F、3 UTIL、3 板凳、2 IR;每日鎖陣容;有 waivers;無賽季異動上限
- **位置名額上限:C 資格球員整隊最多只能持有 4 人(已對照 ESPN League Settings 確認,其他位置都是 No Limit)**。幫 Leo 評估或推薦任何 C 資格的自由球員之前,一定要先確認他目前是不是已經卡滿 4 個 C。
- 計分:PTS 1、FGM 2、FGA -1、FTM 1、FTA -1、3PM 2、3PA -1、OREB 1、REB 1、AST 2、STL 4、BLK 4、TO -2、PF -1、QD(四響,quadruple-double)20、Team Win 2;有 bonus wins/losses;無 keepers
- 聯盟已由管理員設為公開,讀 ESPN API 不需要登入

## 球員評估原則

評估球員不要只看本季的小樣本數據:要合併上季數據(ESPN「2026 season」平均,套用這個聯盟自己的計分公式換算)與本季數據一起看,並用 roster % 當輔助訊號(不是主要依據)。

## 內容方向(給之後接手維護 `data.json` 手寫內容的人參考)

- NBA 賽後摘要
- Threads 上的 NBA fantasy 貼文摘要(關鍵字「NBA fantasy」保留最新 5 篇並附來源連結;目前追蹤的帳號:`@fantasy_baskets_`、`@fantasy.moose`〔范特西慕斯,內容偏進階數據/選秀分級/週賽程策略〕,Leo 之後會陸續加帳號)
- 依賽程的每週 streaming 推薦
- 每日「潛力 sleeper」區塊:因隊上傷兵或教練調整而增加上場時間的自由球員
- 早上的第二次更新要提醒:隊上有 DTD/OUT 球員已經可以出賽卻還坐板凳
- 版面:開頭是「今天要做什麼」檢查表,其餘內容用分頁(tab)呈現,避免太雜亂
- 每週對戰面板:每天顯示實際得分,下面小字顯示預測總分
- v2 的新功能先放在標為「功能測試」的分頁:交易分析器、背靠背疲勞風險、位置稀缺度、季後賽排位、聯盟全體未來對手、滾動得分趨勢、緊急事件橫幅
- 每個版本都要有版本號與 changelog(寫明改了什麼);舊紀錄收合成單一「v1」條目,之後從 v2.x 往下編號(目前最新是 v2.28)

## 給 Claude Code 的工作規則(從 claude.ai 那邊的工作方式換算過來)

claude.ai 那邊的 Claude 原本的規則是:畫面相關的改動只能先做在 claude.ai 的 Artifact 預覽裡,用高亮框起來給 Leo 確認,Leo 明確說「上傳」才會推上 GitHub。**Claude Code 沒有 Artifact 預覽/高亮這套機制,所以等效的做法建議如下:**

1. **純後端/純邏輯/純資料的修正**(不影響畫面長相,例如計算錯誤、API 抓取邏輯、gate.mjs 的判斷條件、資料來源修正)→ 可以直接 commit + push 到 `main`,不用先問 Leo。push 後**一定要對照 ESPN 即時資料或實際網站畫面驗證過才算完成**,不能只憑程式碼邏輯推論就回報完成。
2. **會影響畫面的改動**(新增/調整版面結構、文字、樣式、新 UI 功能)→ 建議先讓 Leo 看過再推上 `main`(因為 `main` 一有 push,GitHub Actions 的 `push` 觸發條件會讓 `update.yml` 立刻跑,`v2/index.html` 幾乎是即時生效,沒有緩衝):
   - 可以開一個分支 + PR 讓 Leo 用 GitHub 介面 review 畫面 diff 再合併,或者
   - 直接說清楚「這次改了哪裡、長什麼樣子」(文字描述或截圖),等 Leo明確同意再 push 到 `main`。
   - 千萬不要自己假設「反正是小改動」就直接上線——Leo 很在意上線前能先看到變了什麼。
3. **絕對不要碰 `index.html`(root,v1)**,所有自動更新與人工修改都只動 `v2/index.html` 和它的資料來源 `data.json`/`update.mjs`/`build.mjs`/`gate.mjs`。
4. **Leo 的 ESPN 網站/App 密碼絕對不能被記住、輸入或使用**,即使 Leo 直接授權也不行——聯盟已設公開,讀資料本來就不需要登入。
5. 需要查 Reddit r/fantasybball 來輔助評估陣容時可以查,但有些環境連不到,連不上要明確說明,不要假裝有查到。
6. 回報完成前,一定要對照實際網站畫面或 ESPN 即時資料驗證得分、傷兵狀態、對手名單、功能是否正確,不要只憑程式碼邏輯判斷就回報「完成」。
7. 溝通用繁體中文。Leo 平常用 iPhone,沒辦法複製貼上 ESPN 的 JSON 時會傳截圖,改用截圖分析畫面內容。

## 已知最近修過的 bug(2026-11-09,供日後排查類似問題參考)

Matchup 3→4 換週當天,決策頁「上週戰報」與「應對策略/勝率預測」兩個區塊整個空白。根因是 `update.mjs` 原本用「對手名字有沒有變」判斷換週,遇到 ESPN 側的 `currentMatchupPeriod` 還沒切換、或剛好連續兩輪同一個對手時會誤判沒換週。已改成用 `matchupBase`(scoring period 編號)比對,並補上 `matchupDays.dates` 每次執行都重新計算(見上面「週報/連戰凍結機制」一節)。這是目前 `v2.28` 的內容。之後如果再出現「畫面某個區塊莫名空白」的狀況,優先懷疑是不是又踩到了類似的「某個 `if` 條件該 true 卻拿到 falsy 資料」的情況,照這次的方法(先看 DOM 哪個區塊空、再回頭查 `v2/index.html` 的渲染條件、再查 `data.json`/`update.mjs`/`build.mjs` 哪個欄位沒被正確產生)去追。
