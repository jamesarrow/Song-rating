import React, { useEffect, useMemo, useRef, useState } from "react";
import { initializeApp, getApps } from "firebase/app";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  addDoc,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  query,
  orderBy,
} from "firebase/firestore";

// 🔹 Конфиг Firebase
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCIxmkUlXPoBdIZEogYNmL9ZC53lRegAAs",
  authDomain: "interhuy-6f374.firebaseapp.com",
  projectId: "interhuy-6f374",
  storageBucket: "interhuy-6f374.firebasestorage.app",
  messagingSenderId: "433371826262",
  appId: "1:433371826262:web:34017bec3b8c01ea8613f7",
  measurementId: "G-LZHG805HBN",
};

const DEFAULT_CRITERIA = [
  "Вокал",
  "Мелодия",
  "Текст",
  "Сценический образ",
  "Хореография",
  "Оригинальность",
  "Аранжировка",
  "Визуал",
  "Подача",
  "Эмоции",
];

const clamp = (n, min = 1, max = 10) => Math.max(min, Math.min(max, Number(n)));
const fmt1 = (n) => (isFinite(n) ? Number(n).toFixed(1).replace(".", ",") : "0,0");

function Pill({ children }) {
  return (
    <span className="inline-block min-w-[2.5rem] rounded-full bg-black px-2 py-1 text-center text-xs font-semibold text-white">
      {children}
    </span>
  );
}

function initFirebase() {
  if (!getApps().length) initializeApp(FIREBASE_CONFIG);
  return getFirestore();
}

const uid = () =>
  localStorage.getItem("songRater.uid") ||
  (localStorage.setItem("songRater.uid", crypto.randomUUID()),
  localStorage.getItem("songRater.uid"));

// 🔹 Главный компонент
export default function App() {
  // ⬇️ тут остаётся весь код логики (useState, useEffect, submitVote, saveCriteria, startRoom и т.д.)
  // ⬇️ я вставил только изменённые выводы

  // В сводке по участникам
  // <td><Pill>{fmt1(r.avg || 0)}</Pill></td> → теперь первая колонка после названия песни

  // В топ-10
  // <Pill>{fmt1(r.avgAll)}</Pill>

  // В итогах по всем песням
  // <td><Pill>{fmt1(r.avgAll)}</Pill></td>

  // В блоке результатов по песне
  // <Stat label="Средняя по всем критериям" value={<Pill>{fmt1(agg.avgAll)}</Pill>} raw />
  // <Stat label="Ваше среднее" value={<Pill>{fmt1(myAvg)}</Pill>} raw />

  // Под слайдерами
  // <Pill>{fmt1(myAvg)}</Pill>
}

// 🔹 Компоненты Stat, Scoreboard и т.д.
function Stat({ label, value, raw = false }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

function Scoreboard({ db, roomId, criteria }) {
  const [rows, setRows] = useState([]);
  const votesUnsubsRef = useRef({});

  useEffect(() => {
    return () => {
      Object.values(votesUnsubsRef.current).forEach((u) => u && u());
      votesUnsubsRef.current = {};
    };
  }, [roomId]);

  useEffect(() => {
    if (!db.current || !roomId) return;

    const unsubSongs = onSnapshot(
      query(collection(db.current, "rooms", roomId, "songs"), orderBy("order", "asc")),
      (qs) => {
        const songs = qs.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
        songs.forEach((song) => {
          if (votesUnsubsRef.current[song.id]) return;
          const unsubVotes = onSnapshot(
            collection(db.current, "rooms", roomId, "songs", song.id, "votes"),
            (vs) => {
              const votes = vs.docs.map((d) => d.data());
              const count = votes.length;
              const perCritSum = Array(criteria.length).fill(0);
              votes.forEach((v) =>
                v.scores?.forEach((x, i) => (perCritSum[i] += Math.max(1, Math.min(10, Number(x)))))
              );
              const perCritAvg = perCritSum.map((s) => (count ? s / count : 0));
              const avgAll = perCritAvg.length ? perCritAvg.reduce((a, b) => a + b, 0) / perCritAvg.length : 0;

              setRows((prev) => {
                const idx = prev.findIndex((r) => r.id === song.id);
                const nextRow = { id: song.id, name: song.name, count, avgAll, perCritAvg };
                if (idx === -1) return [...prev, nextRow];
                const cp = [...prev];
                cp[idx] = nextRow;
                return cp;
              });
            }
          );
          votesUnsubsRef.current[song.id] = unsubVotes;
        });
      }
    );
    return () => {
      unsubSongs?.();
    };
  }, [db, roomId, criteria.length]);

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-lg font-semibold">Итоги по всем песням (realtime)</h3>
      {rows.length === 0 ? (
        <div className="text-xs text-neutral-500">Пока нет данных</div>
      ) : (
        <table className="min-w-full divide-y divide-neutral-200">
          <thead>
            <tr>
              <th>#</th>
              <th>Песня</th>
              <th>Голосов</th>
              <th>Средняя</th>
              {criteria.map((c, i) => <th key={i}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {[...rows].sort((a, b) => b.avgAll - a.avgAll).map((r, idx) => (
              <tr key={r.id}>
                <td>{idx + 1}</td>
                <td>{r.name}</td>
                <td>{r.count}</td>
                <td><Pill>{fmt1(r.avgAll)}</Pill></td>
                {r.perCritAvg.map((x, i) => (
                  <td key={i}>{fmt1(x)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
