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
 * - Комнаты по коду
 * - Участники по имени
 * - Песни + «Сейчас играет»
 * - Слайдеры 1–10 по 10 критериям
 * - Кнопка «Оценить» сохраняет голос (нет автосейва)
 * - Рилтайм средние по песне и таблица всех песен
 */

// ⬇ твой конфиг (оставляю как ты прислал)
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
const fmt2 = (n) => (isFinite(n) ? n.toFixed(2).replace(".", ",") : "0,00");
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

  // gate
  const [roomId, setRoomId] = useState(() => localStorage.getItem("songRater.roomId") || "");
  const [displayName, setDisplayName] = useState(() => localStorage.getItem("songRater.name") || "");
  const [step, setStep] = useState("gate"); // gate | lobby
  const myUid = uid();

  // room state
  const [criteria, setCriteria] = useState(DEFAULT_CRITERIA);
  const [songs, setSongs] = useState([]); // {id,name,order}
  const [activeSongId, setActiveSongId] = useState(null);
  const [participants, setParticipants] = useState([]);

  // UI state
  const [newSong, setNewSong] = useState("");
  const [selectedSongId, setSelectedSongId] = useState(null);

  // my sliders (локально, без автосейва)
  const [myScores, setMyScores] = useState(() => Array(10).fill(5));

  // aggregates for selected song
  const [agg, setAgg] = useState({ count: 0, avgAll: 0, perCritAvg: Array(10).fill(0) });

  // submit button state
  const [saving, setSaving] = useState(false);

  // boot
  useEffect(() => {
    dbRef.current = initFirebase();
    setReady(true);
  }, []);

  // join room
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
      setCriteria(data?.criteria || DEFAULT_CRITERIA);
      setActiveSongId(data?.activeSongId || null);
    });

    const unsubParts = onSnapshot(collection(db, "rooms", rid, "participants"), (qs) => {
      setParticipants(qs.docs.map((d) => ({ id: d.id, ...(d.data() || {}) })));
    });

    const unsubSongs = onSnapshot(
      query(collection(db, "rooms", rid, "songs"), orderBy("order", "asc")),
      (qs) => {
        const list = qs.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
        setSongs(list);
        const prefer = list.find((s) => s.id === (activeSongId || "")) || list[0];
        setSelectedSongId((prev) => prev || prefer?.id || null);
      }
    );

    setStep("lobby");

    return () => {
      unsubRoom?.();
      unsubParts?.();
      unsubSongs?.();
    };
  };

  // активная песня
  const setRoomActiveSong = async (sid) => {
    if (!sid) return;
    await updateDoc(doc(dbRef.current, "rooms", roomId), { activeSongId: sid });
    setSelectedSongId(sid);
  };

  // добавить песню
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

  // слушаем МОИ сохранённые голоса (для текущей песни), но НЕ сбрасываем локальные,
  // если документа ещё нет — это и ломало ползунок
  useEffect(() => {
    if (!ready || !roomId || !selectedSongId) return;
    const myVoteRef = doc(dbRef.current, "rooms", roomId, "songs", selectedSongId, "votes", myUid);
    const unsubMine = onSnapshot(myVoteRef, (s) => {
      const data = s.data();
      if (data && Array.isArray(data.scores) && data.scores.length) {
        setMyScores(data.scores.map((n) => clamp(n)));
      }
      // если документа нет — никаких сбросов на 5
    });

    // агрегаты по песне
    const unsubAgg = onSnapshot(
      collection(dbRef.current, "rooms", roomId, "songs", selectedSongId, "votes"),
      (qs) => {
        const votes = qs.docs.map((d) => d.data());
        const count = votes.length;
        const perCritSum = Array(10).fill(0);
        votes.forEach((v) => v.scores?.forEach((x, i) => (perCritSum[i] += clamp(x))));
        const perCritAvg = perCritSum.map((s) => (count ? s / count : 0));
        const avgAll = perCritAvg.length
          ? perCritAvg.reduce((a, b) => a + b, 0) / perCritAvg.length
          : 0;
        setAgg({ count, perCritAvg, avgAll });
      }
    );

    return () => {
      unsubMine?.();
      unsubAgg?.();
    };
  }, [ready, roomId, selectedSongId]);

  // отправка голоса только по кнопке
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
          <p className="mb-6 text-sm text-neutral-500">
            Введите имя и код комнаты. Все участники видят результаты в реальном времени.
          </p>

          <form onSubmit={startRoom} className="space-y-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
            <div>
              <label className="mb-1 block text-xs text-neutral-500">Ваше имя</label>
              <input
                className="w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none ring-neutral-400 focus:ring"
                placeholder="Например: Сергей"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                r
