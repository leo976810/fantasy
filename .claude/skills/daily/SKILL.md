---
name: daily
description: 每日更新 AESPA 日報的手寫判斷(今天要做的事、Threads 動態)。每天在新對話裡執行一次;只讀 brief.json,寫一份小的 hand.json,套用後 push。
model: sonnet
---

# 每日更新(手寫判斷)

網站其他區塊都由 GitHub Actions 自動更新,這裡只寫 `todo` 和 `threads`。目標是少讀、少寫:不要整份讀 `data.json` 或 `v2/index.html`。

## 步驟

1. 在 repo 根目錄 `git pull -q`。
2. 讀 `brief.json`(約 4 KB)。看 `numbersAsof` 是否是今天;太舊就到 GitHub Actions 手動觸發一次 `update-data`(`gh workflow run update-data`),跑完再 `git pull` 重讀。
3. 需要細節時只取特定欄位,例如:
   `node -e "const h=require('fs').readFileSync('v2/index.html','utf8');const A=JSON.parse(h.match(/<script id=\"data\" type=\"application\/json\">([\s\S]*?)<\/script>/)[1]);console.log(JSON.stringify(A.picks))"`
4. Threads:用內建瀏覽器開 `https://www.threads.com/@fantasy.moose` 和 `https://www.threads.com/@fantasy_baskets_`,用 `get_page_text`(max_chars 3000)讀最新貼文,再用下面這段取得貼文連結與時間:
   `[...new Set([...document.querySelectorAll('a[href*="/post/"]')].map(a=>a.getAttribute('href')).filter(h=>!h.includes('/media')))].slice(0,6).map(h=>{const t=document.querySelector('a[href="'+h+'"] time');return h+' '+(t?t.getAttribute('datetime'):'')})`
   每個帳號取最新 2 到 3 篇,用自己的話各寫一句摘要(不要大段引用),`age` 寫發文日期(例如 `11/12`)。關鍵字搜尋在未登入時無法依時間排序,`search` 留空並在 `skipped` 說明。讀不到就照實寫,不要編。
5. 寫 `todo`:2 到 4 條自動待辦沒有涵蓋的策略判斷(自動待辦已經有:先發調整、傷兵先發、增補首選、本週局勢、背靠背)。例如:增補首選是 waiver 還是自由球員的取捨、對手的傷兵回歸、本週輸贏差距與要不要多加人。數字一律取自 `brief.json`。
6. 把內容寫成暫存檔 `hand.json`(放在 scratchpad,不要放進 repo),格式見 `apply-hand.mjs` 開頭的說明,然後:
   `node apply-hand.mjs <hand.json 的路徑>`
7. `git add data.json`,commit(訊息例如「11/12 每日判斷」),`git pull --rebase`,`git push`。push 會觸發 Actions 重建網站。
8. 等 Actions 跑完(`gh run watch <id> --exit-status`),`git pull` 後確認 `brief.json` 的 `staleSections` 是空的。
9. 用兩三句話回報今天寫了什麼,然後結束這個對話。
