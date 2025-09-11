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
 * Song Contest Rater — Realtime (Firebase)
 * - Флаги для любой страны (RU/EN) через Intl.DisplayNames
 * - Аватар участника: загрузка, авто-кроп в круг (dataURL в Firestore)
 * - Плашка «Сейчас: Страна» большая и зелёная (особенно на мобилках)
 * - Мобайл: Песни(аккордеон) → Критерии → Участники → Итоги → Топ-10
 * - ПК: слева Песни, справа Критерии/Участники/Итоги/Топ-10
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

const MAX_CRITERIA = 20;
const clamp = (n, min = 1, max = 10) => Math.max(min, Math.min(max, Number(n)));
const fmt1 = (n) => (isFinite(n) ? Number(n).toFixed(1).replace(".", ",") : "0,0");

function Pill({ children, className = "" }) {
  return (
    <span className={`inline-block min-w-[2.5rem] rounded-full bg-black px-2 py-1 text-center text-xs font-semibold text-white ${className}`}>
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

/* ===== Флаги для любой страны (RU/EN) ===== */
function isoFlag(iso2) {
  if (!iso2) return "";
  const A = 127397;
  return String.fromCodePoint(...iso2.toUpperCase().split("").map((c) => c.charCodeAt(0) + A));
}
function allRegionCodes() {
  if (typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function") {
    try {
      const list = Intl.supportedValuesOf("region");
      if (Array.isArray(list) && list.length) return list;
    } catch {}
  }
  const dn = new Intl.DisplayNames(["en"], { type: "region" });
  const out = [];
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a) + String.fromCharCode(b);
      const name = dn.of(code);
      if (name && name !== code) out.push(code);
    }
  }
  return out;
}
let COUNTRY_MAP_CACHE = null;
function buildCountryMap() {
  if (COUNTRY_MAP_CACHE) return COUNTRY_MAP_CACHE;
  const codes = allRegionCodes();
  const dnRu = new Intl.DisplayNames(["ru"], { type: "region" });
  const dnEn = new Intl.DisplayNames(["en"], { type: "region" });
  const map = new Map();
  codes.forEach((code) => {
    const ru = (dnRu.of(code) || "").toLowerCase();
    const en = (dnEn.of(code) || "").toLowerCase();
    if (ru) map.set(ru, code);
    if (en) map.set(en, code);
  });
  COUNTRY_MAP_CACHE = map;
  return map;
}
function extractCountry(name) {
  if (!name) return "";
  const parts = name.split(/—|–|-/);
  return (parts[0] || "").trim();
}
function flagEmojiFromCountryName(countryName) {
  if (!countryName) return "";
  const map = buildCountryMap();
  const norm = countryName.trim().toLowerCase();
  const code = map.get(norm);
  return code ? isoFlag(code) : "";
}

/* ===== Аватар: crop в круг и dataURL ===== */
async function imageFileToCircleDataURL(file, size = 256) {
  const dataUrl = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = dataUrl;
  });
  const s = Math.min(img.width, img.height);
  const sx = (img.width - s) / 2;
  const sy = (img.height - s) / 2;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
  ctx.restore();

  return canvas.toDataURL("image/png", 0.92);
}

/* ===== Средние ===== */
function computeAveragesFromVotes(votes, criteriaLen) {
  const K = Math.max(1, criteriaLen);
  const perSum = Array(K).fill(0);
  const perCnt = Array(K).fill(0);
  votes.forEach((v) => {
    if (!v || !Array.isArray(v.scores)) return;
    for (let i = 0; i < K; i++) {
      const x = v.scores[i];
      if (x != null) {
        perSum[i] += clamp(x);
        perCnt[i] += 1;
      }
    }
  });
  const perCritAvg = perSum.map((s, i) => (perCnt[i] ? s / perCnt[i] : 0));
  const valid = perCritAvg.filter((_, i) => perCnt[i] > 0);
  const avgAll = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
  return { perCritAvg, avgAll };
}

export default function App() {
  const dbRef = useRef(null);
  const criteriaRef = useRef(DEFAULT_CRITERIA);
  const [ready, setReady] = useState(false);

  const [roomId, setRoomId] = useState(() => localStorage.getItem("songRater.roomId") || "");
  const [displayName, setDisplayName] = useState(() => localStorage.getItem("songRater.name") || "");
  const [step, setStep] = useState("gate");
  const myUid = uid();

  const [criteria, setCriteria] = useState(DEFAULT_CRITERIA);
  const [songs, setSongs] = useState([]);
  const [activeSongId, setActiveSongId] = useState(null);
  const [participants, setParticipants] = useState([]);

  const [newSong, setNewSong] = useState("");
  const [selectedSongId, setSelectedSongId] = useState(null);
  const [editingCriteria, setEditingCriteria] = useState(false);
  const [criteriaDraft, setCriteriaDraft] = useState(DEFAULT_CRITERIA);
  const [myScores, setMyScores] = useState(() => Array(DEFAULT_CRITERIA.length).fill(5));
  const [saving, setSaving] = useState(false);

  const [isWide, setIsWide] = useState(false);
  useEffect(() => {
    const mm = window.matchMedia("(min-width: 640px)");
    const onChange = () => setIsWide(mm.matches);
    onChange();
    mm.addEventListener("change", onChange);
    return () => mm.removeEventListener("change", onChange);
  }, []);

  const [songsOpen, setSongsOpen] = useState(false);

  const [selectedParticipantId, setSelectedParticipantId] = useState("");
  const [participantRows, setParticipantRows] = useState([]);

  const myParticipant = useMemo(
    () => participants.find((p) => p.id === myUid),
    [participants, myUid]
  );
  const avatarInputRef = useRef(null);
  const onClickAvatar = () => avatarInputRef.current?.click();
  const onPickAvatar = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await imageFileToCircleDataURL(file, 256);
      await setDoc(
        doc(dbRef.current, "rooms", roomId, "participants", myUid),
        { photoData: dataUrl, updatedAt: serverTimestamp() },
        { merge: true }
      );
    } catch {
      alert("Не удалось загрузить аватар. Попробуй другой файл.");
    } finally {
      e.target.value = "";
    }
  };

  const [topRows, setTopRows] = useState([]);
  const topVotesUnsubsRef = useRef({});

  useEffect(() => {
    dbRef.current = initFirebase();
    setReady(true);
  }, []);

  useEffect(() => {
    const K = Math.max(1, criteria.length);
    criteriaRef.current = criteria;
    setMyScores((prev) => {
      const arr = Array(K).fill(5);
      for (let i = 0; i < K; i++) arr[i] = clamp(prev[i] ?? 5);
      return arr;
    });
  }, [criteria]);

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
    await setDoc(
      doc(db, "rooms", rid, "participants", myUid),
      { name, updatedAt: serverTimestamp() },
      { merge: true }
    );
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
        data?.criteria && Array.isArray(data.criteria) && data.criteria.length >= 1
          ? data.criteria.slice(0, MAX_CRITERIA)
          : DEFAULT_CRITERIA;
      setCriteria(nextCriteria);
      criteriaRef.current = nextCriteria;
      setCriteriaDraft(nextCriteria);
      setActiveSongId(data?.activeSongId || null);
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

    const unsubSongsForTop = onSnapshot(
      query(collection(db, "rooms", rid, "songs"), orderBy("order", "asc")),
      (qs) => {
        const listSongs = qs.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
        listSongs.forEach((song) => {
          if (topVotesUnsubsRef.current[song.id]) return;
          const u = onSnapshot(collection(db, "rooms", rid, "songs", song.id, "votes"), (vs) => {
            const votes = vs.docs.map((d) => d.data());
            const { avgAll } = computeAveragesFromVotes(votes, Math.max(1, criteriaRef.current.length));
            setTopRows((prev) => {
              const idx = prev.findIndex((r) => r.id === song.id);
              const nextRow = { id: song.id, name: song.name, avgAll };
              if (idx === -1) return [...prev, nextRow];
              const cp = [...prev];
              cp[idx] = nextRow;
              return cp;
            });
          });
          topVotesUnsubsRef.current[song.id] = u;
        });
        const existing = new Set(listSongs.map((s) => s.id));
        Object.entries(topVotesUnsubsRef.current).forEach(([songId, u]) => {
          if (!existing.has(songId)) {
            u && u();
            delete topVotesUnsubsRef.current[songId];
            setTopRows((prev) => prev.filter((r) => r.id !== songId));
          }
        });
      }
    );

    setStep("lobby");

    return () => {
      unsubRoom?.();
      unsubParts?.();
      unsubSongs?.();
      unsubSongsForTop?.();
      Object.values(topVotesUnsubsRef.current).forEach((u) => u && u());
      topVotesUnsubsRef.current = {};
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
    const country = extractCountry(name);
    const flag = flagEmojiFromCountryName(country);
    const res = await addDoc(collection(dbRef.current, "rooms", roomId, "songs"), {
      name,
      order,
      flag: flag || null,
      createdAt: serverTimestamp(),
    });
    setNewSong("");
    setSelectedSongId(res.id);
    await setRoomActiveSong(res.id);
  };

  useEffect(() => {
    if (!ready || !roomId || !selectedSongId) return;
    const myVoteRef = doc(dbRef.current, "rooms", roomId, "songs", selectedSongId, "votes", myUid);
    const unsubMine = onSnapshot(myVoteRef, (s) => {
      const data = s.data();
      if (data && Array.isArray(data.scores)) {
        const K = Math.max(1, criteria.length);
        setMyScores((prev) => {
          const arr = Array(K).fill(5);
          for (let i = 0; i < K; i++) arr[i] = clamp(data.scores[i] ?? prev[i] ?? 5);
          return arr;
        });
      }
    });
    return () => unsubMine?.();
  }, [ready, roomId, selectedSongId, criteria.length]);

  useEffect(() => {
    if (!ready || !roomId || !selectedParticipantId || !songs.length) {
      setParticipantRows([]);
      return;
    }
    const K = Math.max(1, criteria.length);
    const unsubs = songs.map((song) =>
      onSnapshot(doc(dbRef.current, "rooms", roomId, "songs", song.id, "votes", selectedParticipantId), (s) => {
        const data = s.data();
        const scores = Array(K)
          .fill(null)
          .map((_, i) => (data && Array.isArray(data.scores) && data.scores[i] != null ? clamp(data.scores[i]) : null));
        const filled = scores.filter((x) => x != null);
        const avg = filled.length ? filled.reduce((a, b) => a + (b || 0), 0) / filled.length : 0;
        const sum = filled.length ? filled.reduce((a, b) => a + (b || 0), 0) : 0;

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
  }, [ready, roomId, selectedParticipantId, songs, criteria.length]);

  const submitVote = async () => {
    if (!ready || !roomId || !selectedSongId) return;
    try {
      setSaving(true);
      const K = Math.max(1, criteria.length);
      const trimmed = Array(K)
        .fill(0)
        .map((_, i) => clamp(myScores[i] ?? 5));
      await setDoc(
        doc(dbRef.current, "rooms", roomId, "songs", selectedSongId, "votes", myUid),
        { scores: trimmed, name: displayName || "Без имени", updatedAt: serverTimestamp() },
        { merge: true }
      );
    } finally {
      setSaving(false);
    }
  };

  const addCriterionDraft = () => {
    if (criteriaDraft.length >= MAX_CRITERIA) return;
    setCriteriaDraft((prev) => [...prev, `Критерий ${prev.length + 1}`]);
  };
  const removeCriterionDraft = (idx) => setCriteriaDraft((prev) => prev.filter((_, i) => i !== idx));
  const saveCriteria = async () => {
    let cleaned = criteriaDraft.map((s) => String(s || "").trim()).filter(Boolean).slice(0, MAX_CRITERIA);
    if (cleaned.length === 0) cleaned = ["Оценка"];
    if (!roomId) return;
    await updateDoc(doc(dbRef.current, "rooms", roomId), { criteria: cleaned });
    setEditingCriteria(false);
  };

  const myAvg = useMemo(() => {
    const filled = myScores.filter((x) => x != null);
    return filled.length ? filled.reduce((a, b) => a + b, 0) / filled.length : 0;
  }, [myScores]);

  const activeSong = songs.find((s) => s.id === activeSongId) || null;
  const activeCountry = extractCountry(activeSong?.name || "");
  const activeFlag = flagEmojiFromCountryName(activeCountry);

  if (!ready) return <div className="p-6 text-sm text-neutral-600">Загрузка…</div>;

  if (step === "gate") {
    return (
      <div className="min-h-screen bg-neutral-50 text-neutral-900">
        <div className="mx-auto max-w-xl px-4 py-10">
          <h1 className="mb-2 text-3xl font-bold">🎶 Song Contest Rater</h1>
          <p className="mb-6 text-sm text-neutral-500">Введите имя и код комнаты.</p>

          <form onSubmit={startRoom} className="space-y-4 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
            <div>
              <label className="mb-1 block text-xs text-neutral-500">Ваше имя</label>
              <input
                className="w-full rounded-xl border border-neutral-300 px-3 py-3 text-sm outline-none ring-neutral-400 focus:ring"
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
                  className="w-full rounded-xl border border-neutral-300 px-3 py-3 text-sm outline-none ring-neutral-400 focus:ring"
                  placeholder="eurovision-2025"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value.toLowerCase())}
                />
              </div>
              <div className="flex items-end">
                <button className="w-full rounded-xl bg-black px-4 py-3 text-sm font-semibold text-white hover:bg-neutral-800">
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
    <div className="min-h-screen bg-neutral-50 text-neutral-900 pb-24 sm:pb-0">
      <div className="mx-auto max-w-7xl px-3 sm:px-4 py-4 sm:py-6">
        {/* шапка */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <div className="text-[10px] uppercase tracking-wide text-neutral-500">Комната</div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* крошечный код */}
              <div className="font-mono text-[11px] text-neutral-400">{roomId}</div>
              {activeSong && (
                <span className="rounded-xl bg-green-600 text-white px-4 py-2 text-sm sm:text-base font-semibold inline-flex items-center gap-1 shadow-sm">
                  <span>{activeFlag}</span>
                  <span>Сейчас: {activeCountry || activeSong.name}</span>
                </span>
              )}
            </div>
            {/* имя крупнее */}
            <div className="text-base sm:text-lg text-neutral-800">
              <span className="text-neutral-600">Вы:</span>{" "}
              <span className="font-semibold">{displayName || "Без имени"}</span>
            </div>
          </div>

          {/* справа (и на мобилках — прижать к правому краю) */}
          <div className="flex items-center gap-3 self-end sm:self-auto">
            <input
              type="file"
              accept="image/*"
              ref={avatarInputRef}
              onChange={onPickAvatar}
              className="hidden"
            />
            <button
              onClick={onClickAvatar}
              title="Загрузить аватар"
              className="relative h-14 w-14 sm:h-12 sm:w-12 rounded-full bg-black flex items-center justify-center overflow-hidden border border-neutral-700"
            >
              {myParticipant?.photoData ? (
                <img alt="avatar" src={myParticipant.photoData} className="h-full w-full object-cover" />
              ) : (
                <span className="text-white text-xl">📷</span>
              )}
            </button>

            <button
              onClick={() => setEditingCriteria(true)}
              className="hidden sm:inline-block rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs shadow-sm hover:bg-neutral-100"
            >
              Редактировать критерии
            </button>
            <button
              onClick={() => setStep("gate")}
              className="hidden sm:inline-block rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs shadow-sm hover:bg-neutral-100"
            >
              Сменить комнату
            </button>
          </div>
        </div>

        {/* быстрые кнопки на мобилке */}
        <div className="sm:hidden mb-3 flex items-center gap-2">
          <button
            onClick={() => setEditingCriteria(true)}
            className="flex-1 rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs shadow-sm hover:bg-neutral-100"
          >
            Редактировать критерии
          </button>
          <button
            onClick={() => setStep("gate")}
            className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs shadow-sm hover:bg-neutral-100"
          >
            Сменить
          </button>
        </div>

        {/* сетка */}
        <div className="grid gap-4 sm:gap-6 xl:grid-cols-3">
          {/* Песни */}
          <div className="order-1 xl:order-none xl:col-span-1 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Песни</h2>
              <button
                className="sm:hidden rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs"
                onClick={() => setSongsOpen((v) => !v)}
              >
                {songsOpen ? "Скрыть список" : "Показать список"}
              </button>
            </div>

            {!songsOpen && !isWide && (
              <div className="mb-3 rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium truncate">
                    {(() => {
                      const s = songs.find((x) => x.id === selectedSongId) || songs[0];
                      if (!s) return "—";
                      const flag = s.flag || flagEmojiFromCountryName(extractCountry(s.name));
                      return (
                        <>
                          <span className="mr-1">{flag}</span>
                          {s.name}
                        </>
                      );
                    })()}
                  </div>
                  <button
                    className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs"
                    onClick={() => setSongsOpen(true)}
                  >
                    Изменить
                  </button>
                </div>
              </div>
            )}

            {(songsOpen || isWide) && (
              <>
                <div className="mb-3 flex gap-2">
                  <input
                    className="flex-1 rounded-xl border border-neutral-300 px-3 py-3 text-sm outline-none ring-neutral-400 focus:ring"
                    placeholder="Страна — Артист — Трек"
                    value={newSong}
                    onChange={(e) => setNewSong(e.target.value)}
                  />
                  <button
                    onClick={addSong}
                    className="rounded-xl bg-black px-4 py-3 text-sm font-semibold text-white hover:bg-neutral-800"
                  >
                    Добавить
                  </button>
                </div>

                <div className="max-h-72 sm:max-h-80 space-y-1 overflow-auto pr-1 -mr-1">
                  {songs.map((s) => {
                    const isSelected = selectedSongId === s.id;
                    const isActive = activeSongId === s.id;
                    const flag = s.flag || flagEmojiFromCountryName(extractCountry(s.name));
                    return (
                      <div
                        key={s.id}
                        className={`flex items-center justify-between rounded-xl border px-3 py-2 text-sm transition ${
                          isActive
                            ? "border-green-500 bg-green-50"
                            : isSelected
                            ? "border-black bg-neutral-50"
                            : "border-neutral-200 bg-white"
                        }`}
                      >
                        <button
                          onClick={() => {
                            setSelectedSongId(s.id);
                            if (!isWide) setSongsOpen(false);
                          }}
                          className="text-left font-medium truncate"
                          title={s.name}
                        >
                          <span className="mr-1">{flag}</span>
                          {s.name}
                        </button>
                        <div className="flex items-center gap-2">
                          {isActive ? (
                            <span className="rounded-full bg-green-600 px-2 py-1 text-xs font-semibold text-white">
                              Активная
                            </span>
                          ) : (
                            <button
                              onClick={() => setRoomActiveSong(s.id)}
                              className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs hover:bg-neutral-100"
                              title="Сделать активной"
                            >
                              Сделать активной
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {songs.length === 0 && (
                    <div className="rounded-xl border border-dashed border-neutral-300 p-4 text-center text-xs text-neutral-500">
                      Пока нет песен. Добавьте первую!
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Критерии */}
          <div className="order-2 xl:order-none xl:col-span-2 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
            <div className="mb-3">
              <h2 className="text-lg font-semibold">
                Оценки: {songs.find((s) => s.id === selectedSongId)?.name || "—"}
              </h2>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:gap-4 sm:grid-cols-2">
              {criteria.map((label, i) => (
                <div key={i} className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-sm font-medium text-neutral-800">{label}</span>
                    <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-neutral-700">
                      {myScores[i] ?? "—"}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    step={1}
                    value={myScores[i] ?? 5}
                    onChange={(e) =>
                      setMyScores((prev) => prev.map((v, idx) => (idx === i ? clamp(e.target.value) : v)))
                    }
                    className="h-3 w-full cursor-pointer appearance-none rounded-full bg-neutral-200 accent-black"
                    disabled={!selectedSongId}
                  />
                  <div className="mt-1 flex justify-between text-[10px] text-neutral-500">
                    <span>1</span>
                    <span>10</span>
                  </div>
                </div>
              ))}
            </div>

            {/* верхняя панель действий (desktop) */}
            <div className="mt-4 hidden sm:flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-neutral-700 flex items-center gap-2">
                <span>Ваша средняя сейчас:</span>
                <Pill>{fmt1(myAvg)}</Pill>
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

          {/* Участники */}
          <div className="order-3 xl:order-none xl:col-span-2 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Участники ({participants.length})</h2>
            </div>

            <div className="mb-3 flex flex-wrap gap-2">
              {participants.map((p) => (
                <span
                  key={p.id}
                  className={`inline-flex items-center gap-2 rounded-xl px-2 py-1 text-sm sm:text-base ${
                    selectedParticipantId === p.id ? "bg-black text-white" : "bg-neutral-100 text-neutral-800"
                  }`}
                  onClick={() => setSelectedParticipantId(p.id)}
                  role="button"
                  title={p.name || "Без имени"}
                >
                  <span className="inline-block h-5 w-5 rounded-full overflow-hidden bg-neutral-800">
                    {p.photoData ? (
                      <img src={p.photoData} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="block h-full w-full" />
                    )}
                  </span>
                  <span className="truncate max-w-[140px] sm:max-w-[220px]">{p.name || "Без имени"}</span>
                </span>
              ))}
              {participants.length === 0 && <span className="text-xs text-neutral-500">Ещё никто не зашёл</span>}
            </div>

            {/* мобайл: карточки */}
            <div className="sm:hidden space-y-2">
              {[...participantRows]
                .sort((a, b) => (b.sum || 0) - (a.sum || 0))
                .map((r) => (
                  <div key={r.songId} className="rounded-xl border border-neutral-200 bg-white p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium text-sm">{r.songName}</div>
                      <Pill>{fmt1(r.avg || 0)}</Pill>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      {criteria.map((c, i) => (
                        <div key={i} className="flex items-center justify-between gap-2">
                          <span className="text-neutral-500 truncate">{c}</span>
                          <span className="font-medium">{r.scores[i] != null ? r.scores[i] : "—"}</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 text-[11px] text-neutral-500">
                      Сумма: <span className="font-semibold text-neutral-700">{r.sum || 0}</span>
                    </div>
                  </div>
                ))}
              {participantRows.length === 0 && (
                <div className="rounded-xl border border-dashed border-neutral-300 p-4 text-center text-xs text-neutral-500">
                  Нет данных
                </div>
              )}
            </div>

            {/* десктоп: таблица */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="min-w-full divide-y divide-neutral-200">
                <thead>
                  <tr className="text-xs text-neutral-600">
                    <th className="px-3 py-2 text-left">Песня</th>
                    <th className="px-3 py-2 text-left">Средн.</th>
                    {criteria.map((c, i) => (
                      <th key={i} className="px-3 py-2 text-left">{c}</th>
                    ))}
                    <th className="px-3 py-2 text-left">Сумма</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {[...participantRows]
                    .sort((a, b) => (b.sum || 0) - (a.sum || 0))
                    .map((r) => (
                      <tr key={r.songId} className="text-sm">
                        <td className="px-3 py-2 font-medium">{r.songName}</td>
                        <td className="px-3 py-2"><Pill>{fmt1(r.avg || 0)}</Pill></td>
                        {r.scores.map((x, i) => (
                          <td key={i} className="px-3 py-2">{x != null ? x : "—"}</td>
                        ))}
                        <td className="px-3 py-2">{r.sum || 0}</td>
                      </tr>
                    ))}
                  {participantRows.length === 0 && (
                    <tr><td className="px-3 py-2 text-xs text-neutral-500">Нет данных</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Итоги по всем песням */}
          <ScoreboardWrap cls="order-4 xl:order-none xl:col-span-2">
            <Scoreboard db={dbRef} roomId={roomId} criteria={criteria} />
          </ScoreboardWrap>

          {/* Топ-10 */}
          <div className="order-5 xl:order-none xl:col-span-1 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
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
                    <li key={r.id} className="flex items-center justify-between rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">
                      <span className="font-semibold">{idx + 1}. {r.name}</span>
                      <Pill>{fmt1(r.avgAll)}</Pill>
                    </li>
                  ))}
              </ol>
            )}
          </div>
        </div>

        {/* модалка критериев */}
        {editingCriteria && (
          <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
            <div className="w-full max-w-xl rounded-2xl border border-neutral-200 bg-white p-4 shadow-xl">
              <h3 className="mb-3 text-lg font-semibold">Редактировать критерии</h3>

              <div className="space-y-2 max-h-[60vh] overflow-auto pr-1">
                {criteriaDraft.map((val, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-6 text-xs text-neutral-500">{i + 1}.</span>
                    <input
                      className="flex-1 rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none ring-neutral-400 focus:ring"
                      value={val}
                      onChange={(e) =>
                        setCriteriaDraft((prev) => prev.map((x, idx) => (idx === i ? e.target.value : x)))
                      }
                      maxLength={40}
                    />
                    <button
                      onClick={() => removeCriterionDraft(i)}
                      className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs hover:bg-neutral-100"
                    >
                      Удалить
                    </button>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex items-center justify-between">
                <button
                  onClick={addCriterionDraft}
                  disabled={criteriaDraft.length >= MAX_CRITERIA}
                  className={`rounded-xl px-3 py-2 text-xs font-semibold ${
                    criteriaDraft.length >= MAX_CRITERIA
                      ? "bg-neutral-200 text-neutral-500"
                      : "bg-black text-white hover:bg-neutral-800"
                  }`}
                >
                  + Добавить критерий
                </button>
                <div className="text-[11px] text-neutral-500">
                  {criteriaDraft.length}/{MAX_CRITERIA}
                </div>
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
                * Минимум один критерий. Средние считаются по существующим позициям.
              </div>
            </div>
          </div>
        )}

        <footer className="mt-6 text-center text-xs text-neutral-400">
          Работает на Firestore · Общие данные для всех в комнате
        </footer>
      </div>

      {/* мобильная панель */}
      <div className="sm:hidden fixed inset-x-0 bottom-0 z-40 border-t border-neutral-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/70">
        <div className="mx-auto max-w-7xl px-3 py-3 flex items-center justify-between gap-3">
          <div className="text-sm text-neutral-700 flex items-center gap-2">
            <span>Средняя:</span>
            <Pill>{fmt1(myAvg)}</Pill>
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
    </div>
  );
}

function ScoreboardWrap({ children, cls }) {
  return <div className={`${cls} rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm`}>{children}</div>;
}

function randomRoomCode() {
  const adj = ["loud", "epic", "fresh", "brave", "lucky", "gold", "neon", "vivid"];
  const noun = ["eurovision", "contest", "party", "song", "final", "semifinal"];
  return `${adj[Math.floor(Math.random() * adj.length)]}-${noun[Math.floor(Math.random() * noun.length)]}-${Math.floor(Math.random() * 1000)}`;
}

/* Итоги по всем песням */
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
              const { perCritAvg, avgAll } = computeAveragesFromVotes(votes, Math.max(1, criteria.length));

              setRows((prev) => {
                const idx = prev.findIndex((r) => r.id === song.id);
                const nextRow = { id: song.id, name: song.name, count: votes.length, avgAll, perCritAvg };
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
    <>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-4 text-center text-xs text-neutral-500">
          Пока нет данных
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-lg font-semibold">Итоги по всем песням</h3>
          </div>

          {/* мобайл */}
          <div className="sm:hidden space-y-2">
            {[...rows].sort((a, b) => b.avgAll - a.avgAll).map((r, idx) => (
              <div key={r.id} className="flex items-center justify-between rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-[11px] text-neutral-500">{idx + 1} место</div>
                  <div className="font-medium text-sm truncate">{r.name}</div>
                  <div className="text-[11px] text-neutral-500">Голосов: {r.count}</div>
                </div>
                <Pill>{fmt1(r.avgAll)}</Pill>
              </div>
            ))}
          </div>

          {/* десктоп */}
          <div className="hidden sm:block overflow-x-auto">
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
                    <td className="px-4 py-2 text-sm font-semibold"><Pill>{fmt1(r.avgAll)}</Pill></td>
                    {r.perCritAvg.map((x, i) => (
                      <td key={i} className="px-4 py-2 text-sm">{fmt1(x)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
