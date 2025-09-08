
# 🎶 Song Contest Rater — Realtime (Firebase + React + Vite)

Готовый проект для общего голосования за песни в реальном времени.

## Быстрый старт (локально)

1) Установите Node.js 18+  
2) В терминале:
```bash
npm i
npm run dev
```
Откройте ссылку из терминала (обычно `http://localhost:5173`).

> Пока что нужно добавить конфиг Firebase в `src/App.jsx` (см. ниже).

## Firebase

- Зайдите в https://console.firebase.google.com → **Add project**.
- Включите **Firestore Database** (Production mode).
- В **Project settings → Your apps → Web** создайте веб‑приложение и возьмите **Config**.
- Вставьте его в `src/App.jsx` в объект `FIREBASE_CONFIG`.

### Firestore Rules

Откройте раздел **Rules** в Firestore и вставьте содержимое `firebase.rules`. Сохраните/опубликуйте.

## Использование

- На первом экране введите **имя** и **код комнаты** (например, `eurovision-2025`). Тот же код отправьте друзьям.
- Добавляйте песни, делайте текущую активной, голосуйте с ползунками 1–10.
- Все видят средние по песне и сводную таблицу по всем песням — в реальном времени.

## Деплой

### Vercel
- Импортируйте репозиторий на https://vercel.com → **Add New Project**
- Framework: **Vite**, Build Command: `npm run build`, Output Dir: `dist`.
- Или через CLI:
```bash
npm i -g vercel
vercel
vercel --prod
```

### Netlify
- https://app.netlify.com → **Add new site** → Import
- Build: `npm run build`, Publish: `dist`

## Настройки/идеи
- Пин-код комнаты и права ведущего
- Таймер выступления и автозакрытие голосования
- Публичная read-only таблица лидеров
- Экспорт результатов в CSV/Google Sheets

Удачи и приятного контеста! 🎉
