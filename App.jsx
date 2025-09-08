
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

/**
 * 🎶 Song Contest Rater — Realtime (Firebase) MVP
 *
 * Что умеет:
 * - Комнаты (Room): один код на компанию. Все видят одни и те же песни/результаты.
 * - Вход по имени, сохраняется локально. Можно видеть список участников.
 * - Список песен + активная «Сейчас играет». Можно добавлять и выбирать.
 * - Каждый оценивает текущую (или любую) песню по 10 критериям слайдерами 1–10.
 * - Голоса пишутся в Firestore в реальном времени (onSnapshot),
 *   все сразу видят средние по песне и по критериям.
 * - Таблица «Итоги» со средними по всем песням.
 *
 * ⚙️ Как запустить:
 * 1) Создайте проект в Firebase → включите Firestore (режим прод).
 * 2) Вставьте ваш конфиг в FIREBASE_CONFIG ниже.
 * 3) Задеплойте на Vercel/Netlify (или локально).
 */

// ⬇️ ВСТАВЬТЕ СВОЙ КОНФИГ FIREBASE
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCIxmkUlXPoBdIZEogYNmL9ZC53lRegAAs",
  authDomain: "interhuy-6f374.firebaseapp.com",
  projectId: "interhuy-6f374",
  storageBucket: "interhuy-6f374.firebasestorage.app",
  messagingSenderId: "433371826262",
  appId: "1:433371826262:web:34017bec3b8c01ea8613f7",
  measurementId: "G-LZHG805HBN"
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
const fmt2 = (n) => (isFinite(n) ? n.toFixed(2).replace(".", ",") : "0,00");
const uid = () =>
  localStorage.getItem("songRater.uid") ||
  (localStorage.setItem("songRater.uid", crypto.randomUUID()), localStorage.getItem("songRater.uid"));

function initFirebase() {
  if (!getApps().length) {
    try {
      initializeApp(FIREBASE_CONFIG);
    } catch (e) {
      console.error("Firebase init failed:", e);
    }
  }
  return getFirestore();
}

export default function App() {
  const dbRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [roomId, setRoomId] = useState(() => localStorage.getItem("songRater.roomId") || "");
  const [displayName, setDisplayName] = useState(() => localStorage.getItem("songRater.name") || "");
  const [step, setStep] = useState("gate"); // gate | lobby

  // Room state
  const [criteria, setCriteria] = useState(DEFAULT_CRITERIA);
  const [songs, setSongs] = useState([]); // [{id,name,order}]
  const [activeSongId, setActiveSongId] = useState(null);
  const [participants, setParticipants] = useState([]); // [{id,name}]

  // UI state
  const [newSong, setNewSong] = useState("");
  const [selectedSongId, setSelectedSongId] = useState(null);
  const myUid = uid();

  // My scores for selected song (local mirror of remote vote document)
  const [myScores, setMyScores] = useState(() => Array(10).fill(5));
  const saveTimer = useRef(null);

  // Aggregates for selected song
  const [agg, setAgg] = useState({ count: 0, avgAll: 0, perCritAvg: Array(10).fill(0) });

  // --- Firebase boot ---
  useEffect(() => {
    const db = initFirebase();
    dbRef.current = db;
    setReady(true);
  }, []);

  // --- Join room: create if not exists, attach listeners ---
  const createRoomIfMissing = async (db, rid, name) => {
    const rDoc = doc(db, "rooms", rid);
    const snap = await getDoc(rDoc);
    if (!snap.exists()) {
      await setDoc(rDoc, {
        createdAt: serverTimestamp(),
        criteria: DEFAULT_CRITERIA,
        activeSongId: null,
      });
    }
    // Add/refresh participant card
    await setDoc(doc(db, "rooms", rid, "participants", myUid), {
      name,
      updatedAt: serverTimestamp(),
    });
  };

  const startRoom = async (e) => {
    e?.preventDefault?.();
    const rid = (roomId || "").trim() || randomRoomCode();
    const name = (displayName || "").trim() || "Без имени";
    localStorage.setItem("songRater.roomId", rid);
    localStorage.setItem("songRater.name", name);

    const db = dbRef.current;
    await createRoomIfMissing(db, rid, name);

    // Listen room meta
    const unsubRoom = onSnapshot(doc(db, "rooms", rid), (s) => {
      const data = s.data();
      setCriteria(data?.criteria || DEFAULT_CRITERIA);
      setActiveSongId(data?.activeSongId || null);
    });

    // Listen participants
    const unsubParts = onSnapshot(collection(db, "rooms", rid, "participants"), (qs) => {
      setParticipants(qs.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }))); 
    });

    // Listen songs
    const unsubSongs = onSnapshot(query(collection(db, "rooms", rid, "songs"), orderBy("order", "asc")), (qs) => {
      const list = qs.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
      setSongs(list);
      // Select song: prefer active, else first
      const prefer = list.find((s) => s.id === (activeSongId || "")) || list[0];
      setSelectedSongId((prev) => prev || prefer?.id || null);
    });

    // Cleanup on room change (not needed in MVP)
    setStep("lobby");

    return () => {
      unsubRoom?.();
      unsubParts?.();
      unsubSongs?.();
    };
  };

  // --- Change active song (anyone can press) ---
  const setRoomActiveSong = async (sid) => {
    if (!sid) return;
    const db = dbRef.current;
    await updateDoc(doc(db, "rooms", roomId), { activeSongId: sid });
    setSelectedSongId(sid);
  };

  // --- Add song ---
  const addSong = async () => {
    const name = newSong.trim();
    if (!name) return;
    const db = dbRef.current;
    const order = (songs[songs.length - 1]?.order || 0) + 1;
    const res = await addDoc(collection(db, "rooms", roomId, "songs"), {
      name,
      order,
      createdAt: serverTimestamp(),
    });
    setNewSong("");
    setSelectedSongId(res.id);
    await setRoomActiveSong(res.id);
  };

  // --- Listen my vote for the selected song; aggregate all votes ---
  useEffect(() => {
    if (!ready || !roomId || !selectedSongId) return;
    const db = dbRef.current;

    // My vote doc
    const myVoteRef = doc(db, "rooms", roomId, "songs", selectedSongId, "votes", myUid);
    const unsubMine = onSnapshot(myVoteRef, (s) => {
      const data = s.data();
      if (data?.scores?.length) setMyScores(data.scores.map((n) => clamp(n)));
      else setMyScores(Array(10).fill(5));
    });

    // Aggregate votes for this song
    const unsubAgg = onSnapshot(collection(db, "rooms", roomId, "songs", selectedSongId, "votes"), (qs) => {
      const votes = qs.docs.map((d) => d.data());
      const count = votes.length;
      const perCritSum = Array(10).fill(0);
      votes.forEach((v) => v.scores?.forEach((x, i) => (perCritSum[i] += clamp(x))));
      const perCritAvg = perCritSum.map((s) => (count ? s / count : 0));
      const avgAll = perCritAvg.length ? perCritAvg.reduce((a, b) => a + b, 0) / perCritAvg.length : 0;
      setAgg({ count, perCritAvg, avgAll });
    });

    return () => {
      unsubMine?.();
      unsubAgg?.();
    };
  }, [ready, roomId, selectedSongId]);

  // --- Auto-save my scores (debounced) ---
  useEffect(() => {
    if (!ready || !roomId || !selectedSongId) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const db = dbRef.current;
      await setDoc(
        doc(db, "rooms", roomId, "songs", selectedSongId, "votes", myUid),
        {
          scores: myScores.map((n) => clamp(n)),
          name: displayName || "Без имени",
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }, 250);
    return () => clearTimeout(saveTimer.current);
  }, [myScores, ready, roomId, selectedSongId, displayName]);

  // --- UI helpers ---
  const myAvg = useMemo(() => (myScores.length ? myScores.reduce((a, b) => a + b, 0) / myScores.length : 0), [myScores]);
  const activeSong = songs.find((s) => s.id === activeSongId) || null;

  if (!ready) return <div className="p-6 text-sm text-neutral-600">Загрузка…</div>;

  if (step === "gate") {
    return (
      <div className="min-h-screen bg-neutral-50 text-neutral-900">
        <div className="mx-auto max-w-xl px-4 py-10">
          <h1 className="mb-2 text-3xl font-bold">🎶 Song Contest Rater — Realtime</h1>
          <p className="mb-6 text-sm text-neutral-500">Создайте комнату (Room) или войдите по коду. Все участники видят песни и результаты в реальном времени.</p>

          <form onSubmit={startRoom} className="space-y-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
            <div>
              <label className="mb-1 block text-xs text-neutral-500">Ваше имя</label>
              <input
                className="w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none ring-neutral-400 focus:ring"
                placeholder="Например: Сергей"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs text-neutral-500">Код комнаты (любой текст)</label>
                <input
                  className="w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none ring-neutral-400 focus:ring"
                  placeholder="Например: eurovision-2025"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value.toLowerCase())}
                />
              </div>
              <div className="flex items-end">
                <button className="w-full rounded-xl bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800">Войти / Создать</button>
              </div>
            </div>
            <p className="text-xs text-neutral-400">Поделиться: отправьте друзьям этот же код комнаты — и они зайдут в ту же сессию.</p>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <div className="mx-auto max-w-6xl px-4 py-6">
        {/* Top bar */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">Комната</div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{roomId}</h1>
              {activeSong && (
                <span className="rounded-lg bg-black px-2 py-1 text-xs font-semibold text-white">Сейчас: {activeSong.name}</span>
              )}
            </div>
            <div className="text-xs text-neutral-500">Вы: <span className="font-medium text-neutral-700">{displayName || "Без имени"}</span></div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setStep("gate")}
              className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs shadow-sm hover:bg-neutral-100"
            >
              Сменить комнату
            </button>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left: Songs & participants */}
          <div className="space-y-6">
            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Песни</h2>
              </div>
              <div className="mb-3 flex gap-2">
                <input
                  className="flex-1 rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none ring-neutral-400 focus:ring"
                  placeholder="Добавить песню: Страна — Артист — Трек"
                  value={newSong}
                  onChange={(e) => setNewSong(e.target.value)}
                />
                <button onClick={addSong} className="rounded-xl bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800">Добавить</button>
              </div>
              <div className="max-h-72 space-y-1 overflow-auto pr-1">
                {songs.map((s) => (
                  <div key={s.id} className={`flex items-center justify-between rounded-xl border px-3 py-2 text-sm ${
                    selectedSongId === s.id ? "border-black bg-neutral-50" : "border-neutral-200 bg-white"
                  }`}>
                    <button onClick={() => setSelectedSongId(s.id)} className="text-left font-medium">{s.name}</button>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setRoomActiveSong(s.id)} className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs hover:bg-neutral-100">Сделать активной</button>
                    </div>
                  </div>
                ))}
                {songs.length === 0 && (
                  <div className="rounded-xl border border-dashed border-neutral-300 p-4 text-center text-xs text-neutral-500">Пока нет песен. Добавьте первую!</div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <h2 className="mb-2 text-lg font-semibold">Участники ({participants.length})</h2>
              <div className="flex flex-wrap gap-2">
                {participants.map((p) => (
                  <span key={p.id} className="rounded-xl bg-neutral-100 px-2 py-1 text-xs text-neutral-700">{p.name || "Без имени"}</span>
                ))}
                {participants.length === 0 && <span className="text-xs text-neutral-500">Ещё никто не зашёл</span>}
              </div>
            </div>
          </div>

          {/* Middle: Sliders */}
          <div className="lg:col-span-2 space-y-6">
            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Оценки: {songs.find((s) => s.id === selectedSongId)?.name || "—"}</h2>
                <div className="text-xs text-neutral-600">Ваше среднее: <span className="font-semibold">{fmt2(myAvg)}</span></div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {criteria.map((label, i) => (
                  <div key={i} className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-sm font-medium text-neutral-800">{label || `Критерий ${i + 1}`}</span>
                      <span className="rounded-lg bg-white px-2 py-0.5 text-xs font-semibold text-neutral-700">{myScores[i]}</span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      step={1}
                      value={myScores[i]}
                      onChange={(e) => setMyScores((prev) => prev.map((v, idx) => (idx === i ? clamp(e.target.value) : v)))}
                      className="h-2 w-full cursor-pointer appearance-none rounded-full bg-neutral-200 accent-black"
                      disabled={!selectedSongId}
                    />
                    <div className="mt-1 flex justify-between text-[10px] text-neutral-500">
                      <span>1</span>
                      <span>10</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Realtime aggregates */}
            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <h3 className="mb-3 text-lg font-semibold">Результаты по песне (realtime)</h3>
              <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Stat label="Голосов" value={agg.count} />
                <Stat label="Средняя по всем критериям" value={fmt2(agg.avgAll)} />
                <Stat label="Ваше среднее" value={fmt2(myAvg)} />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {criteria.map((c, i) => (
                  <div key={i} className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm">
                    <div className="mb-1 text-neutral-600">{c}</div>
                    <div className="text-lg font-semibold">{fmt2(agg.perCritAvg[i] || 0)}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Scoreboard */}
            <Scoreboard db={dbRef} roomId={roomId} criteria={criteria} />
          </div>
        </div>

        <footer className="mt-6 text-center text-xs text-neutral-400">Realtime на Firestore · Данные общие для всех в комнате</footer>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

function randomRoomCode() {
  const adj = ["loud", "epic", "fresh", "brave", "lucky", "gold", "neon", "vivid"]; 
  const noun = ["eurovision", "contest", "party", "song", "final", "semifinal"];
  return `${adj[Math.floor(Math.random()*adj.length)]}-${noun[Math.floor(Math.random()*noun.length)]}-${Math.floor(Math.random()*1000)}`;
}

function Scoreboard({ db, roomId, criteria }) {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    if (!db.current || !roomId) return;
    const unsubSongs = onSnapshot(query(collection(db.current, "rooms", roomId, "songs"), orderBy("order", "asc")), async (qs) => {
      const list = qs.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));

      // For each song, listen its votes once (fan-out listeners)
      const getOne = (song) =>
        new Promise((resolve) => {
          const unsub = onSnapshot(collection(db.current, "rooms", roomId, "songs", song.id, "votes"), (vs) => {
            const votes = vs.docs.map((d) => d.data());
            const count = votes.length;
            const perCritSum = Array(criteria.length).fill(0);
            votes.forEach((v) => v.scores?.forEach((x, i) => (perCritSum[i] += Math.max(1, Math.min(10, Number(x))))));
            const perCritAvg = perCritSum.map((s) => (count ? s / count : 0));
            const avgAll = perCritAvg.length ? perCritAvg.reduce((a, b) => a + b, 0) / perCritAvg.length : 0;
            resolve({ id: song.id, name: song.name, count, avgAll, perCritAvg });
            unsub(); // one-shot per outer tick
          });
        });

      const data = await Promise.all(list.map(getOne));
      setRows(data);
    });
    return () => unsubSongs?.();
  }, [db, roomId, criteria.length]);

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-lg font-semibold">Итоги по всем песням (realtime)</h3>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-4 text-center text-xs text-neutral-500">Пока нет данных</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-neutral-200">
            <thead className="bg-neutral-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-neutral-600">#</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-neutral-600">Песня</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-neutral-600">Голосов</th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-neutral-600">Средняя</th>
                {criteria.map((c, i) => (
                  <th key={i} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-neutral-600">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {[...rows].sort((a, b) => b.avgAll - a.avgAll).map((r, idx) => (
                <tr key={r.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-2 text-sm text-neutral-500">{idx + 1}</td>
                  <td className="px-4 py-2 text-sm font-medium text-neutral-900">{r.name}</td>
                  <td className="px-4 py-2 text-sm">{r.count}</td>
                  <td className="px-4 py-2 text-sm font-semibold">{fmt2(r.avgAll)}</td>
                  {r.perCritAvg.map((x, i) => (
                    <td key={i} className="px-4 py-2 text-sm">{fmt2(x)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
