const CACHE_NAME = 'tra-search-cache-v2';
const urlsToCache = [
    './index.html',
    './manifest.json',
    // 雖然外部資源一般不快取，但為了功能運行，我們快取主要的 CSS 和 JS
    //'https://cdn.tailwindcss.com',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+TC:wght@400;500;700&display=swap',
    // 請記得把你的圖示檔案路徑也加進來，例如：
    './icon-192x192.png',
    './icon-512x512.png'
];

// --- Service Worker 專用的 API 認證資訊 ---
const TDX_CLIENT_ID = 'jacky841026-3f8ab20a-1893-42cc'; // 請替換成您的 ID
const TDX_CLIENT_SECRET = 'd44c0656-19f7-4ae5-86a5-f8feba4ecf71'; // 請替換成您的 Secret

// 注意: 在 Service Worker 中，我們需要自行管理 Token
let tdxAccessToken = null;
const TRACKING_KEY = 'tra_tracking_list';

// --- 輔助函式 (複製自 index.html) ---
// 獲取 TDX API 認證 Token
async function getTdxAccessToken() {
    if (tdxAccessToken) return tdxAccessToken;

    const authUrl = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', TDX_CLIENT_ID);
    params.append('client_secret', TDX_CLIENT_SECRET);

    const response = await fetch(authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
    });

    if (!response.ok) {
        console.error('Service Worker: 無法取得 TDX Access Token');
        return null;
    }

    const data = await response.json();
    tdxAccessToken = data.access_token;
    return tdxAccessToken;
}

// [真實] 獲取指定列車的即時誤點資料 (只查一個班次會更有效率，但 TDX 不支援單一查詢，故仍查詢全部)
async function fetchDelays() {
    try {
        const token = await getTdxAccessToken();
        if (!token) return [];
        const apiUrl = 'https://tdx.transportdata.tw/api/basic/v2/Rail/TRA/LiveBoard?&format=JSON';

        const response = await fetch(apiUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) {
            console.error("Service Worker: 無法獲取即時誤點資訊");
            return [];
        }
        const liveData = await response.json();
        // 整理成我們需要的格式 { TrainNo, DelayTime }
        return liveData.map(item => ({ TrainNo: item.TrainNo, DelayTime: item.DelayTime, NextStationID: item.NextStationID, StationID: item.StationID }));
    } catch (error) {
        console.error('Service Worker: 查詢誤點資料失敗:', error);
        return [];
    }
}

// [真實] 獲取車站資訊
async function fetchStations() {
    try {
        const token = await getTdxAccessToken();
        if (!token) return [];
        const apiUrl = 'https://tdx.transportdata.tw/api/basic/v2/Rail/TRA/Station?&format=JSON';
        const response = await fetch(apiUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) return [];
        return await response.json();
    } catch (error) {
        console.error('Service Worker: 查詢車站資料失敗:', error);
        return [];
    }
}


// [真實] 獲取指定班次停靠站點時刻表
async function fetchTrainTimetable(trainNo, date) {
    try {
        const token = await getTdxAccessToken();
        if (!token) return null;
        const apiUrl = `https://tdx.transportdata.tw/api/basic/v2/Rail/TRA/DailyTimetable/TrainNo/${trainNo}/${date}?$format=JSON`;

        const response = await fetch(apiUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
            console.error(`Service Worker: 無法獲取 ${trainNo} 班次時刻表`);
            return null;
        }
        const data = await response.json();
        // TDX API 返回陣列，我們只取第一個
        return data.length > 0 ? data[0] : null;
    } catch (error) {
        console.error(`Service Worker: 查詢 ${trainNo} 班次時刻表失敗:`, error);
        return null;
    }
}

// 獲取追蹤清單 (Service Worker 無法直接讀取 LocalStorage，需從主頁面傳遞)
let trackingList = []; 
// Service Worker 的啟動時機不一定能從 LocalStorage 讀到，所以主要依賴主頁面傳遞

// 定期檢查和發送通知的核心邏輯
async function checkAndNotify() {
    console.log(`[Service Worker] 開始檢查追蹤列車，清單數量: ${trackingList.length}`);
    if (trackingList.length === 0) return;
    
    // 獲取所有必要的資料
    const delays = await fetchDelays();
    // 💡 為了教學示範，我們在 SW 裡直接用假資料模擬車站，實際應用中應從 API 取得並快取
    const allStations = await fetchStations(); 
    // 將 API 返回的 stations 轉為 {id: name} 的 Map 方便查找
    const stationMap = allStations.reduce((acc, s) => {
        acc[s.StationID] = s.StationName.Zh_tw;
        return acc;
    }, {});
    
    const today = new Date().toISOString().split('T')[0];

    for (const item of trackingList) {
        const delayInfo = delays.find(d => d.TrainNo === item.trainNo);

        // 如果列車目前沒有誤點資訊，則跳過
        if (!delayInfo) continue;

        // 取得該班次的詳細時刻表
        const timetable = await fetchTrainTimetable(item.trainNo, today);
        if (!timetable) continue;
        
        // 找到使用者乘車站的時刻表項目
        const fromStop = timetable.StopTime.find(s => s.StationID === item.fromStationId);
        
        if (!fromStop) continue;

        const scheduledArrivalTime = fromStop.ArrivalTime; // 預計抵達使用者乘車站的時間
        
        // 列車最新資訊
        const latestStationID = delayInfo.StationID; // 列車目前在哪一站 (或剛離開)
        const delayMinutes = delayInfo.DelayTime; // 誤點分鐘數

        // 1. 計算列車預計抵達使用者乘車站的時間
        // 將預計到達時間 (HH:mm) 轉換為分鐘數 (從午夜開始)
        const [schH, schM] = scheduledArrivalTime.split(':').map(Number);
        const scheduledArrivalMins = schH * 60 + schM;
        
        // 加上誤點分鐘數
        const estimatedArrivalMins = scheduledArrivalMins + delayMinutes;
        
        // 當前時間 (SW 運行時的時間)
        const now = new Date();
        const nowMins = now.getHours() * 60 + now.getMinutes();

        // 剩餘分鐘數
        let remainingMins = estimatedArrivalMins - nowMins;
        // 處理跨日情況 (例如 23:50 班次，但現在 00:05)
        if (remainingMins < -1440) remainingMins += 2880; // -1440 是一天
        if (remainingMins < 0 && remainingMins > -1440) remainingMins += 1440; // 跨日校正

        
        // 2. 找到下一站 (NextStationID)
        const nextStationName = stationMap[delayInfo.NextStationID] || '未知下一站';

        // 3. 判斷是否要發送通知
        
        // a) 列車已抵達或已過站，移除追蹤
if (remainingMins <= -5) {
             const title = `⚠️ 列車 ${item.trainNo} 次已過站`;
             const body = `列車已於約 ${Math.abs(remainingMins)} 分鐘前抵達 ${stationMap[item.fromStationId]}。已自動移除追蹤。`;
             // 【修正點 D：修正通知圖示路徑】
             self.registration.showNotification(title, { body: body, tag: `tra-track-${item.trainNo}`, icon: './icon-192x192.png' });
             trackingList = trackingList.filter(t => t.trainNo !== item.trainNo);
             continue;
        }

        // b) 預計 5, 10, 15 分鐘後到達使用者乘車站
if (remainingMins > 0 && (remainingMins === 5 || remainingMins === 10 || remainingMins === 15 || remainingMins === 30)) {
            const trainTypeName = timetable.DailyTrainInfo.TrainTypeName.Zh_tw;
            const title = `🔔 ${trainTypeName} ${item.trainNo} 次即將抵達 ${stationMap[item.fromStationId]}`;
            const body = `還有 ${remainingMins} 分鐘到達 (${delayMinutes > 0 ? `晚 ${delayMinutes} 分` : '準點'})。\n目前駛往 ${nextStationName}`;
            // 【修正點 D：修正通知圖示路徑】
            self.registration.showNotification(title, { body: body, tag: `tra-track-${item.trainNo}`, renotify: true, icon: './icon-192x192.png' });
        }
    }
}
// 安裝 Service Worker 並快取資源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // 1. 快取內部資源 (使用 cache.addAll)
      const internalCachePromise = cache.addAll(urlsToCache);
      
      // 2. 單獨快取跨域資源 (使用 fetch 配合 no-cors)
      const cdnCachePromise = fetch('https://cdn.tailwindcss.com/', { mode: 'no-cors' })
        .then(response => {
          // 由於是 no-cors，response.ok 可能是 false，但仍可以快取
          return cache.put('https://cdn.tailwindcss.com/', response);
        });

      // 等待所有快取完成
      return Promise.all([internalCachePromise, cdnCachePromise]);
    })
  );
});

// 攔截網路請求，優先從快取中回應
self.addEventListener('fetch', event => {
  // 忽略跨域的 API 請求，我們只快取靜態資源
  if (event.request.url.startsWith('https://tdx.transportdata.tw')) {
    return;
  }
  
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // 快取中有資源則直接回傳
        if (response) {
          return response;
        }
        // 快取中沒有則嘗試發出網路請求
        return fetch(event.request);
      })
  );
});

// 清理舊的快取
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
    if (!self.intervalId) {
        // 每 1 分鐘檢查一次
        checkAndNotify(); 
        self.intervalId = setInterval(checkAndNotify, 60000); 
    }
});

// 接收主頁面傳來的訊息 (特別是追蹤清單更新)
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'TRACKING_LIST_UPDATED') {
        trackingList = event.data.list;
        console.log('[Service Worker] 追蹤清單已更新', trackingList);
    }
});
