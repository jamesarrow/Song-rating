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
 * 🎶 Song Contest Rater — Realtime
 * - Кнопка «Оценить», без автосейва
 * - Редактируемые критерии (10)
 * - Сводка по участнику
 * - Топ-10 по СРЕДНЕЙ оценке (не сумме)
 * - Все средние округляются до десятых
 */

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
const uid = () =>
  localStorage.getItem("songRater.uid") ||
  (localStorage.setItem("songRater.uid", crypto.randomUUID()),
  localStorage.getItem("songRater.uid"));

function initFirebase() {
  if (!getApps().length) initializeApp(FIREBASE_CONFIG);
  return getFirestore();
}

export default function App() {
  const dbRef = useRef(null);
  const [ready, setReady] = useState(false);

  // вход
  const [roomId, setRoomId] = useState(() => localStorage.getItem("songRater.roomId") || "");
  const [displayName, setDisplayName] = useState(() => localStorage.getItem("songRater.name") || "");
  const [step, setStep] = useState("gate");
  const myUid = uid();

  // состояние комнаты
  const [criteria, setCriteria] = useState(DEFAULT_CRITERIA);
  const [songs, setSongs] = useState([]); // {id,name,order}
  const [activeSongId, setActiveSongId] = useState(null);
  const [participants, setParticipants] = useState([]);

  // UI
  const [newSong, setNewSong] = useState("");
  const [selectedSongId, setSelectedSongId] = useState(null);
  const [editingCriteria, setEditingCriteria] = useState(false);
  const [criteriaDraft, setCriteriaDraft] = useState(DEFAULT_CRITERIA);

  // мои оценки (локально)
  const [myScores, setMyScores] = useState(() => Array(10).fill(5));
  const [saving, setSaving] = useState(false);

  // агрегаты по выбранной песне
  const [agg, setAgg] = useState({ count: 0, avgAll: 0, perCritAvg: Array(10).fill(0) });

  // сводка по участнику
  const [selectedParticipantId, setSelectedParticipantId] = useState("");
  const [participantRows, setParticipantRows] = useState([]); // {songId,songName,scores[],avg,sum}

  // топ-10 по средней оценке
  const [topRows, setTopRows] = useState([]); // {id,name,avgAll}

  useEffect(() => {
    dbRef.current = initFirebase();
    setReady(true);
  }, []);

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

    const unsubRoom = onSnapshot(doc(db, "rooms", rid), (s) => {
      const data = s.data();
      const nextCriteria =
        data?.criteria && Array.isArray(data.criteria) && data.criteria.length === 10
          ? data.criteria
          : DEFAULT_CRITERIA;
      setCriteria(nextCriteria);
      setCriteriaDraft(nextCriteria);
      setActiveSongId(data?.activeSongId || null);
      setMyScores((prev) => {
        const arr = Array(10).fill(5);
        for (let i = 0; i < 10; i++) arr[i] = clamp(prev[i] ?? 5);
        return arr;
      });
    });

    const unsubParts = onSnapshot(collection(db, "rooms", rid, "participants"), (qs) => {
      const list = qs.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
      setParticipants(list);
      if (!selectedParticipantId && list.length) setSelectedParticipantId(list[0].id);
    });

    const unsubSongs = onSnapshot(query(collection(db, "rooms", rid, "songs"), orderBy("order", "asc")), (qs) => {
      const list = qs.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
      setSongs(list);
      const prefer = list.find((s) => s.id === (activeSongId || "")) || list[0];
      setSelectedSongId((prev) => prev || prefer?.id || null);
    });

    // топ-10: слушаем все песни и их голоса → считаем среднюю по всем участникам и критериям
    const unsubSongsForTop = onSnapshot(query(collection(db, "rooms", rid, "songs"), orderBy("order", "asc")), (qs) => {
      const list = qs.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
      const unsubs = [];
      list.forEach((song) => {
        const u = onSnapshot(collection(db, "rooms", rid, "songs", song.id, "votes"), (vs) => {
          const votes = vs.docs.map((d) => d.data());
          const count = votes.length;
          const sumAll = votes.reduce((acc, v) => {
            if (!Array.isArray(v.scores)) return acc;
            return acc + v.scores.reduce((a, b) => a + clamp(b), 0); // 10..100 per vote
          }, 0);
          const avgAll = count > 0 ? sumAll / (count * 10) : 0; // средняя по всем критериям и участникам
          setTopRows((prev) => {
            const idx = prev.findIndex((r) => r.id === song.id);
            const nextRow = { id: song.id, name: song.name, avgAll };
            if (idx === -1) return [...prev, nextRow];
            const cp = [...prev];
            cp[idx] = nextRow;
            return cp;
          });
        });
        unsubs.push(u);
      });
      return () => unsubs.forEach((u) => u && u());
    });

    setStep("lobby");

    return () => {
      unsubRoom?.();
      unsubParts?.();
      unsubSongs?.();
      unsubSongsForTop?.();
    };
  };

  const setRoomActiveSong = async (sid) => {
    if (!sid) return;
    await updateDoc(doc(dbRef.current, "rooms", roomId), { activeSongId: sid });
    setSelectedSongId(sid);
  };

  const addSong = async () => {
    const name = newSong.trim();
    if (!name) return;
    const order = (songs[songs.length - 1]?.order || 0) + 1;
    const res = await addDoc(collection(dbRef.current, "rooms", roomId, "songs"), {
      name,
      order,
      createdAt: serverTimestamp(),
    });
    setNewSong("");
    setSelectedSongId(res.id);
    await setRoomActiveSong(res.id);
  };

  // мои сохранённые оценки и агрегаты по выбранной песне
  useEffect(() => {
    if (!ready || !roomId || !selectedSongId) return;

    const myVoteRef = doc(dbRef.current, "rooms", roomId, "songs", selectedSongId, "votes", myUid);
    const unsubMine = onSnapshot(myVoteRef, (s) => {
      const data = s.data();
      if (data && Array.isArray(data.scores) && data.scores.length) {
        setMyScores(() => {
          const arr = Array(10).fill(5);
          for (let i = 0; i < 10; i++) arr[i] = clamp(data.scores[i] ?? 5);
          return arr;
        });
      }
    });

    const unsubAgg = onSnapshot(
      collection(dbRef.current, "rooms", roomId, "songs", selectedSongId, "votes"),
      (qs) => {
        const votes = qs.docs.map((d) => d.data());
        const count = votes.length;
        const perCritSum = Array(10).fill(0);
        votes.forEach((v) => v.scores?.forEach((x, i) => (perCritSum[i] += clamp(x))));
        const perCritAvg = perCritSum.map((s) => (count ? s / count : 0));
        const avgAll = perCritAvg.length ? perCritAvg.reduce((a, b) => a + b, 0) / perCritAvg.length : 0;
        setAgg({ count, perCritAvg, avgAll });
      }
    );

    return () => {
      unsubMine?.();
      unsubAgg?.();
    };
  }, [ready, roomId, selectedSongId]);

  // сводка выбранного участника
  useEffect(() => {
    if (!ready || !roomId || !selectedParticipantId || !songs.length) {
      setParticipantRows([]);
      return;
    }
    const unsubs = songs.map((song) =>
      onSnapshot(doc(dbRef.current, "rooms", roomId, "songs", song.id, "votes", selectedParticipantId), (s) => {
        const data = s.data();
        let scores = Array(10).fill(null);
        if (data && Array.isArray(data.scores)) {
          scores = Array(10)
            .fill(null)
            .map((_, i) => (data.scores[i] != null ? clamp(data.scores[i]) : null));
        }
        const filled = scores.filter((x) => x != null);
        const avg = filled.length ? filled.reduce((a, b) => a + (b || 0), 0) / filled.length : 0;
        const sum = scores.reduce((a, b) => a + (b || 0), 0);
        setParticipantRows((prev) => {
          const idx = prev.findIndex((r) => r.songId === song.id);
          const next = { songId: song.id, songName: song.name, scores, avg, sum };
          if (idx === -1) return [...prev, next];
          const cp = [...prev];
          cp[idx] = next;
          return cp;
        });
      })
    );
    return () => unsubs.forEach((u) => u && u());
  }, [ready, roomId, selectedParticipantId, songs]);

  const submitVote = async () => {
    if (!ready || !roomId || !selectedSongId) return;
    try {
      setSaving(true);
      await setDoc(
        doc(dbRef.current, "rooms", roomId, "songs", selectedSongId, "votes", myUid),
        {
          scores: myScores.map((n) => clamp(n)),
          name: displayName || "Без имени",
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } finally {
      setSaving(false);
    }
  };

  const saveCriteria = async () => {
    const cleaned = criteriaDraft.map((s) => String(s || "").slice(0, 40));
    while (cleaned.length < 10) cleaned.push("");
    if (!roomId) return;
    await updateDoc(doc(dbRef.current, "rooms", roomId), { criteria: cleaned.slice(0, 10) });
    setEditingCriteria(false);
  };

  const myAvg = useMemo(
    () => (myScores.length ? myScores.reduce((a, b) => a + b, 0) / myScores.length : 0),
    [myScores]
  );
  const activeSong = songs.find((s) => s.id === activeSongId) || null;

  if (!ready) return <div className="p-6 text-sm text-neutral-600">Загрузка…</div>;

  if (step === "gate") {
    return (
      <div className="min-h-screen bg-neutral-50 text-neutral-900">
        <div className="mx-auto max-w-xl px-4 py-10">
          <h1 className="mb-2 text-3xl font-bold">🎶 Song Contest Rater — Realtime</h1>
          <p className="mb-6 text-sm text-neutral-500">Введите имя и код комнаты.</p>

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
                <label className="mb-1 block text-xs text-neutral-500">Код комнаты</label>
                <input
                  className="w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none ring-neutral-400 focus:ring"
                  placeholder="eurovision-2025"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value.toLowerCase())}
                />
              </div>
              <div className="flex items-end">
                <button className="w-full rounded-xl bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800">
                  Войти / Создать
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <div className="mx-auto max-w-7xl px-4 py-6">
        {/* top bar */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">Комната</div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{roomId}</h1>
              {activeSong && (
                <span className="rounded-lg bg-black px-2 py-1 text-xs font-semibold text-white">
                  Сейчас: {activeSong.name}
                </span>
              )}
            </div>
            <div className="text-xs text-neutral-500">
              Вы: <span className="font-medium text-neutral-700">{displayName || "Без имени"}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setEditingCriteria(true)}
              className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs shadow-sm hover:bg-neutral-100"
            >
              Редактировать критерии
            </button>
            <button
              onClick={() => setStep("gate")}
              className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs shadow-sm hover:bg-neutral-100"
            >
              Сменить комнату
            </button>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-3">
          {/* ЛЕВАЯ КОЛОНКА */}
          <div className="space-y-6">
            {/* Песни */}
            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Песни</h2>
              </div>
              <div className="mb-3 flex gap-2">
                <input
                  className="flex-1 rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none ring-neutral-400 focus:ring"
                  placeholder="Страна — Артист — Трек"
                  value={newSong}
                  onChange={(e) => setNewSong(e.target.value)}
                />
                <button
                  onClick={addSong}
                  className="rounded-xl bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800"
                >
                  Добавить
                </button>
              </div>
              <div className="max-h-72 space-y-1 overflow-auto pr-1">
                {songs.map((s) => (
                  <div
                    key={s.id}
                    className={`flex items-center justify-between rounded-xl border px-3 py-2 text-sm ${
                      selectedSongId === s.id ? "border-black bg-neutral-50" : "border-neutral-200 bg-white"
                    }`}
                  >
                    <button onClick={() => setSelectedSongId(s.id)} className="text-left font-medium">
                      {s.name}
                    </button>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setRoomActiveSong(s.id)}
                        className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs hover:bg-neutral-100"
                      >
                        Сделать активной
                      </button>
                    </div>
                  </div>
                ))}
                {songs.length === 0 && (
                  <div className="rounded-xl border border-dashed border-neutral-300 p-4 text-center text-xs text-neutral-500">
                    Пока нет песен. Добавьте первую!
                  </div>
                )}
              </div>
            </div>

            {/* Участники + сводка по участнику */}
            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Участники ({participants.length})</h2>
              </div>

              <div className="mb-3 flex flex-wrap gap-2">
                {participants.map((p) => (
                  <span
                    key={p.id}
                    className={`rounded-xl px-2 py-1 text-xs ${
                      selectedParticipantId === p.id ? "bg-black text-white" : "bg-neutral-100 text-neutral-700"
                    }`}
                    onClick={() => setSelectedParticipantId(p.id)}
                    role="button"
                  >
                    {p.name || "Без имени"}
                  </span>
                ))}
                {participants.length === 0 && <span className="text-xs text-neutral-500">Ещё никто не зашёл</span>}
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-neutral-200">
                  <thead>
                    <tr className="text-xs text-neutral-600">
                      <th className="px-3 py-2 text-left">Песня</th>
                      {criteria.map((c, i) => (
                        <th key={i} className="px-3 py-2 text-left">
                          {c}
                        </th>
                      ))}
                      <th className="px-3 py-2 text-left">Средн.</th>
                      <th className="px-3 py-2 text-left">Сумма</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {[...participantRows]
                      .sort((a, b) => (b.sum || 0) - (a.sum || 0))}
                      {participantRows.length === 0 && (
                        <tr>
                          <td className="px-3 py-2 text-xs text-neutral-500">Нет данных</td>
                        </tr>
                      )}
                    {participantRows.map((r) => (
                      <tr key={r.songId} className="text-sm">
                        <td className="px-3 py-2 font-medium">{r.songName}</td>
                        {r.scores.map((x, i) => (
                          <td key={i} className="px-3 py-2">{x != null ? x : "—"}</td>
                        ))}
                        <td className="px-3 py-2">{fmt1(r.avg || 0)}</td>
                        <td className="px-3 py-2">{r.sum || 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Топ-10 по средней оценке */}
            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-lg font-semibold">Топ-10 (средняя оценка)</h2>
              {topRows.length === 0 ? (
                <div className="rounded-xl border border-dashed border-neutral-300 p-4 text-center text-xs text-neutral-500">
                  Пока нет данных
                </div>
              ) : (
                <ol className="space-y-1">
                  {[...topRows]
                    .sort((a, b) => b.avgAll - a.avgAll)
                    .slice(0, 10)
                    .map((r, idx) => (
                      <li
                        key={r.id}
                        className="flex items-center justify-between rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm"
                      >
                        <span className="font-semibold">
                          {idx + 1}. {r.name}
                        </span>
                        <span className="text-neutral-700">{fmt1(r.avgAll)}</span>
                      </li>
                    ))}
                </ol>
              )}
            </div>
          </div>

          {/* ПРАВАЯ ЧАСТЬ: слайдеры + итоги */}
          <div className="xl:col-span-2 space-y-6">
            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <div className="mb-3">
                <h2 className="text-lg font-semibold">
                  Оценки: {songs.find((s) => s.id === selectedSongId)?.name || "—"}
                </h2>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {criteria.map((label, i) => (
                  <div key={i} className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-sm font-medium text-neutral-800">{label}</span>
                      <span className="rounded-lg bg-white px-2 py-0.5 text-xs font-semibold text-neutral-700">
                        {myScores[i]}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      step={1}
                      value={myScores[i]}
                      onChange={(e) =>
                        setMyScores((prev) => prev.map((v, idx) => (idx === i ? clamp(e.target.value) : v)))
                      }
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

              <div className="mt-4 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm text-neutral-700">
                  Ваша средняя сейчас: <span className="font-semibold">{fmt1(myAvg)}</span>
                </div>
                <button
                  onClick={submitVote}
                  disabled={!selectedSongId || saving}
                  className={`rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-sm ${
                    !selectedSongId || saving ? "bg-neutral-400" : "bg-black hover:bg-neutral-800"
                  }`}
                >
                  {saving ? "Сохраняю…" : "Оценить"}
                </button>
              </div>
            </div>

            {/* Итоги по выбранной песне */}
            <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
              <h3 className="mb-3 text-lg font-semibold">Результаты по песне (realtime)</h3>
              <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Stat label="Голосов" value={agg.count} />
                <Stat label="Средняя по всем критериям" value={fmt1(agg.avgAll)} />
                <Stat label="Ваше среднее" value={fmt1(myAvg)} />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {criteria.map((c, i) => (
                  <div key={i} className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm">
                    <div className="mb-1 text-neutral-600">{c}</div>
                    <div className="text-lg font-semibold">{fmt1(agg.perCritAvg[i] || 0)}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Таблица «Итоги по всем песням» (по средним, 1 знак) */}
            <Scoreboard db={dbRef} roomId={roomId} criteria={criteria} />
          </div>
        </div>

        {/* Модалка редактирования критериев */}
        {editingCriteria && (
          <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
            <div className="w-full max-w-xl rounded-2xl border border-neutral-200 bg-white p-4 shadow-xl">
              <h3 className="mb-3 text-lg font-semibold">Редактировать критерии</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {criteriaDraft.map((val, i) => (
                  <div key={i} className="space-y-1">
                    <div className="text-xs text-neutral-500">Критерий {i + 1}</div>
                    <input
                      className="w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none ring-neutral-400 focus:ring"
                      value={val}
                      onChange={(e) =>
                        setCriteriaDraft((prev) => prev.map((x, idx) => (idx === i ? e.target.value : x)))
                      }
                      maxLength={40}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => {
                    setCriteriaDraft(criteria);
                    setEditingCriteria(false);
                  }}
                  className="rounded-xl border border-neutral-300 bg-white px-4 py-2 text-sm hover:bg-neutral-100"
                >
                  Отмена
                </button>
                <button
                  onClick={saveCriteria}
                  className="rounded-xl bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800"
                >
                  Сохранить
                </button>
              </div>
              <div className="mt-2 text-[11px] text-neutral-500">
                * Меняются только названия (всегда 10). Старые голоса остаются.
              </div>
            </div>
          </div>
        )}

        <footer className="mt-6 text-center text-xs text-neutral-400">
          Realtime на Firestore · Данные общие для всех в комнате
        </footer>
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
  return `${adj[Math.floor(Math.random() * adj.length)]}-${noun[Math.floor(Math.random() * noun.length)]}-${Math.floor(
    Math.random() * 1000
  )}`;
}

/** Таблица итогов — по средним (1 знак после запятой) */
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

        const existingIds = new Set(songs.map((s) => s.id));
        Object.entries(votesUnsubsRef.current).forEach(([songId, unsub]) => {
          if (!existingIds.has(songId)) {
            unsub && unsub();
            delete votesUnsubsRef.current[songId];
            setRows((prev) => prev.filter((r) => r.id !== songId));
          }
        });
      }
    );

    return () => {
      unsubSongs?.();
    };
  }, [db, roomId, criteria.length]);

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-lg font-semibold">Итоги по всем песням (realtime)</h3>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-4 text-center text-xs text-neutral-500">
          Пока нет данных
        </div>
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
                  <th key={i} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-neutral-600">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {[...rows].sort((a, b) => b.avgAll - a.avgAll).map((r, idx) => (
                <tr key={r.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-2 text-sm text-neutral-500">{idx + 1}</td>
                  <td className="px-4 py-2 text-sm font-medium text-neutral-900">{r.name}</td>
                  <td className="px-4 py-2 text-sm">{r.count}</td>
                  <td className="px-4 py-2 text-sm font-semibold">{fmt1(r.avgAll)}</td>
                  {r.perCritAvg.map((x, i) => (
                    <td key={i} className="px-4 py-2 text-sm">{fmt1(x)}</td>
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
