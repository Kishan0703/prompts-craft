import React, { useState, useEffect, useRef } from 'react';
import { ably } from './ably';

const TOTAL_ROUNDS = 7;
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const ABLY_API_KEY = import.meta.env.VITE_ABLY_API_KEY;
const GAME_SESSION_KEY = 'promptcraft_game_session';
const ROOM_CODE_LENGTH = 5;

const getSavedSession = () => {
    try {
        const parsed = JSON.parse(localStorage.getItem(GAME_SESSION_KEY) || 'null');
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
        localStorage.removeItem(GAME_SESSION_KEY);
        return null;
    }
};

export default function App() {
    const saved = getSavedSession();
    const [gameState, setGameState] = useState(() => {
        const savedState = saved?.gameState || 'landing';
        if (['playing', 'waiting-room', 'waiting-finish', 'joining-room'].includes(savedState)) {
            return 'landing';
        }
        return savedState;
    }); // 'landing', 'waiting-room', 'joining-room', 'playing', 'waiting-finish', 'versus-final'
    const [playerName, setPlayerName] = useState(() => getSavedSession()?.playerName || '');
    const [currentRound, setCurrentRound] = useState(() => getSavedSession()?.currentRound || 1);
    const [scores, setScores] = useState(() => getSavedSession()?.scores || []); // { round, score, feedback }
    const [leaderboard, setLeaderboard] = useState([]);
    const [roomCode, setRoomCode] = useState(() => getSavedSession()?.roomCode || '');
    const [joinCode, setJoinCode] = useState('');
    const [isCreator, setIsCreator] = useState(() => getSavedSession()?.isCreator || false);
    const [roomError, setRoomError] = useState('');
    const [copied, setCopied] = useState(false);

    const [opponentName, setOpponentName] = useState(() => getSavedSession()?.opponentName || '');
    const [opponentRound, setOpponentRound] = useState(() => getSavedSession()?.opponentRound || 0);
    const [opponentScores, setOpponentScores] = useState(() => getSavedSession()?.opponentScores || Array(TOTAL_ROUNDS).fill(null));
    const [opponentTotal, setOpponentTotal] = useState(() => getSavedSession()?.opponentTotal || 0);
    const [opponentFinished, setOpponentFinished] = useState(() => getSavedSession()?.opponentFinished || false);
    const [opponentLeft, setOpponentLeft] = useState(false);
    const [disconnectedBanner, setDisconnectedBanner] = useState(false);

    const [promptText, setPromptText] = useState(() => getSavedSession()?.promptText || '');
    const [isLoading, setIsLoading] = useState(false);
    const [apiError, setApiError] = useState('');
    const [roundResult, setRoundResult] = useState(() => getSavedSession()?.roundResult || null); // { score, feedback }

    const [shake, setShake] = useState(false);
    const textareaRef = useRef(null);
    const channelRef = useRef(null);
    const channelHandlerRef = useRef(null);
    const playersRef = useRef(new Set());
    const disconnectTimeoutRef = useRef(null);

    const gameStateRef = useRef(gameState);
    const playerNameRef = useRef(playerName);
    const isCreatorRef = useRef(isCreator);
    const scoresRef = useRef(scores);
    const opponentScoresRef = useRef(opponentScores);
    const opponentTotalRef = useRef(opponentTotal);
    const opponentFinishedRef = useRef(opponentFinished);
    const opponentNameRef = useRef(opponentName);

    useEffect(() => { gameStateRef.current = gameState; }, [gameState]);
    useEffect(() => { playerNameRef.current = playerName; }, [playerName]);
    useEffect(() => { isCreatorRef.current = isCreator; }, [isCreator]);
    useEffect(() => { scoresRef.current = scores; }, [scores]);
    useEffect(() => { opponentScoresRef.current = opponentScores; }, [opponentScores]);
    useEffect(() => { opponentTotalRef.current = opponentTotal; }, [opponentTotal]);
    useEffect(() => { opponentFinishedRef.current = opponentFinished; }, [opponentFinished]);
    useEffect(() => { opponentNameRef.current = opponentName; }, [opponentName]);

    useEffect(() => {
        const session = {
            gameState,
            playerName,
            roomCode,
            isCreator,
            currentRound,
            scores,
            promptText,
            roundResult,
            opponentName,
            opponentRound,
            opponentScores,
            opponentTotal,
            opponentFinished
        };
        localStorage.setItem(GAME_SESSION_KEY, JSON.stringify(session));
    }, [gameState, playerName, roomCode, isCreator, currentRound, scores, promptText, roundResult, opponentName, opponentRound, opponentScores, opponentTotal, opponentFinished]);

    useEffect(() => {
        loadLeaderboard();
    }, [gameState]); // reload when reaching landing page etc.

    useEffect(() => {
        return () => {
            if (disconnectTimeoutRef.current) {
                clearTimeout(disconnectTimeoutRef.current);
            }
            if (channelRef.current) {
                const channel = channelRef.current;
                if (playerNameRef.current) {
                    channel.publish('player-left', { name: playerNameRef.current }).catch(() => { });
                }
                if (channelHandlerRef.current) {
                    channel.unsubscribe(channelHandlerRef.current);
                } else {
                    channel.unsubscribe();
                }
            }
        };
    }, []);

    // ---------------------------------------------------------------------------
    // GAME LOGIC & HELPERS
    // ---------------------------------------------------------------------------
    const loadLeaderboard = () => {
        try {
            const lb = JSON.parse(localStorage.getItem('promptcraft_leaderboard') || '[]');
            setLeaderboard(lb);
        } catch (e) {
            setLeaderboard([]);
        }
    };

    const saveToLeaderboard = (name, finalScore) => {
        let lb = JSON.parse(localStorage.getItem('promptcraft_leaderboard') || '[]');
        const existingIdx = lb.findIndex(entry => entry.name === name);
        if (existingIdx !== -1) {
            if (finalScore > lb[existingIdx].score) {
                lb[existingIdx].score = finalScore;
            }
        } else {
            lb.push({ name, score: finalScore });
        }
        lb.sort((a, b) => b.score - a.score);
        lb = lb.slice(0, 10);
        localStorage.setItem('promptcraft_leaderboard', JSON.stringify(lb));
        setLeaderboard(lb);
    };

    const triggerShake = () => {
        setShake(true);
        setTimeout(() => setShake(false), 500);
    };

    const getTotal = (vals) => vals.reduce((acc, curr) => acc + (Number(curr) || 0), 0);

    const generateRoomCode = () => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code = '';
        for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
        return code;
    };

    const normalizeRoomCode = (value) => value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);

    const resetRun = () => {
        setCurrentRound(1);
        setScores([]);
        setPromptText('');
        setRoundResult(null);
        setApiError('');
        setOpponentRound(0);
        setOpponentScores(Array(TOTAL_ROUNDS).fill(null));
        setOpponentTotal(0);
        setOpponentFinished(false);
        setOpponentLeft(false);
        setDisconnectedBanner(false);
    };

    const publishRoomEvent = async (eventName, payload) => {
        const channel = channelRef.current;
        if (!channel) return;
        try {
            await channel.publish(eventName, payload);
        } catch (err) {
            console.error('Publish failed:', err);
        }
    };

    const cleanupRoom = (sendLeave = true, resetState = true) => {
        if (disconnectTimeoutRef.current) {
            clearTimeout(disconnectTimeoutRef.current);
            disconnectTimeoutRef.current = null;
        }

        if (channelRef.current) {
            const channel = channelRef.current;
            const channelName = channel.name;

            if (sendLeave && playerNameRef.current) {
                channel.publish('player-left', { name: playerNameRef.current }).catch(() => { });
            }

            if (channelHandlerRef.current) {
                channel.unsubscribe(channelHandlerRef.current);
            } else {
                channel.unsubscribe();
            }

            channel.detach(() => { });
            ably.channels.release(channelName);
            channelRef.current = null;
            channelHandlerRef.current = null;
        }

        playersRef.current = new Set();

        if (resetState) {
            setRoomCode('');
            setJoinCode('');
            setOpponentName('');
            setOpponentRound(0);
            setOpponentScores(Array(TOTAL_ROUNDS).fill(null));
            setOpponentTotal(0);
            setOpponentFinished(false);
            setOpponentLeft(false);
            setDisconnectedBanner(false);
            setRoomError('');
            setCopied(false);
        }
    };

    const toVersusFinal = (incomingScores = opponentScoresRef.current, incomingTotal = opponentTotalRef.current) => {
        const normalizedOpponent = Array.from({ length: TOTAL_ROUNDS }, (_, idx) => Number(incomingScores?.[idx] ?? 0));
        const fixedOpponentTotal = Number.isFinite(Number(incomingTotal)) ? Number(incomingTotal) : getTotal(normalizedOpponent);
        const localRoundScores = scoresRef.current.map((entry) => entry.score);
        const localTotal = getTotal(localRoundScores);

        setOpponentScores(normalizedOpponent);
        setOpponentTotal(fixedOpponentTotal);
        setOpponentFinished(true);
        saveToLeaderboard(playerNameRef.current, localTotal);
        if (opponentNameRef.current) {
            saveToLeaderboard(opponentNameRef.current, fixedOpponentTotal);
        }
        setGameState('versus-final');
    };

    const startPlaying = () => {
        resetRun();
        setGameState('playing');
    };

    const handleIncomingMessage = (message) => {
        const data = message?.data || {};
        const incomingName = data.name;
        if (!incomingName || incomingName === playerNameRef.current) return;

        if (message.name === 'player-joined') {
            playersRef.current.add(playerNameRef.current);
            playersRef.current.add(incomingName);
            setOpponentName((prev) => prev || incomingName);
            setOpponentLeft(false);

            if (playersRef.current.size > 2) {
                setRoomError('Room is full.');
                return;
            }

            if (gameStateRef.current === 'waiting-room' && isCreatorRef.current) {
                startPlaying();
            }
        }

        if (message.name === 'round-complete') {
            const roundNum = Math.max(1, Math.min(TOTAL_ROUNDS, Number(data.round) || 1));
            const roundScore = Math.max(0, Math.min(100, Number(data.score) || 0));

            setOpponentName((prev) => prev || incomingName);
            setOpponentRound((prev) => Math.max(prev, roundNum));
            setOpponentTotal(Math.max(0, Number(data.totalSoFar) || 0));
            setOpponentScores((prev) => {
                const next = [...prev];
                next[roundNum - 1] = roundScore;
                return next;
            });
        }

        if (message.name === 'game-complete') {
            const incomingScoresArray = Array.from({ length: TOTAL_ROUNDS }, (_, idx) => Number(data.scores?.[idx] ?? 0));
            const incomingTotalScore = Number(data.total) || getTotal(incomingScoresArray);

            setOpponentName((prev) => prev || incomingName);
            setOpponentScores(incomingScoresArray);
            setOpponentTotal(incomingTotalScore);
            setOpponentFinished(true);
            setOpponentRound(TOTAL_ROUNDS);

            if (scoresRef.current.length === TOTAL_ROUNDS) {
                toVersusFinal(incomingScoresArray, incomingTotalScore);
            }
        }

        if (message.name === 'player-left') {
            setOpponentLeft(true);

            if (['waiting-room', 'waiting-finish', 'joining-room'].includes(gameStateRef.current)) {
                setRoomError('Opponent left. Return to lobby?');
                return;
            }

            if (gameStateRef.current === 'playing') {
                setDisconnectedBanner(true);
                if (disconnectTimeoutRef.current) {
                    clearTimeout(disconnectTimeoutRef.current);
                }

                disconnectTimeoutRef.current = setTimeout(() => {
                    const filledOpponent = Array.from({ length: TOTAL_ROUNDS }, (_, idx) => Number(opponentScoresRef.current[idx] ?? 0));
                    const fallbackTotal = getTotal(filledOpponent);
                    setOpponentScores(filledOpponent);
                    setOpponentTotal(fallbackTotal);
                    setOpponentFinished(true);
                    toVersusFinal(filledOpponent, fallbackTotal);
                }, 5000);
            }
        }
    };

    const subscribeToRoom = async (code, creatorMode) => {
        if (!ABLY_API_KEY) {
            setRoomError('Configuration Error: Ably API Key is missing.');
            return false;
        }

        if (channelRef.current) {
            cleanupRoom(false);
        }

        const channelName = `promptcraft-${code}`;
        const channel = ably.channels.get(channelName);
        channelRef.current = channel;
        setRoomCode(code);
        setRoomError('');
        playersRef.current = new Set([playerNameRef.current]);

        if (!creatorMode) {
            try {
                const page = await channel.history({ limit: 100 });
                const activePlayers = new Set();
                const items = [...page.items].reverse();
                items.forEach((msg) => {
                    const name = msg?.data?.name;
                    if (!name) return;
                    if (msg.name === 'player-joined') activePlayers.add(name);
                    if (msg.name === 'player-left') activePlayers.delete(name);
                });

                const others = [...activePlayers].filter((name) => name !== playerNameRef.current);
                if (others.length >= 2) {
                    setRoomError('Room is full.');
                    ably.channels.release(channelName);
                    channelRef.current = null;
                    return false;
                }
                if (others.length > 0) {
                    setOpponentName(others[0]);
                    playersRef.current.add(others[0]);
                }
            } catch (err) {
                console.error('History read failed:', err);
            }
        }

        channelHandlerRef.current = (msg) => handleIncomingMessage(msg);
        channel.subscribe(channelHandlerRef.current);
        return true;
    };

    const createRoom = async () => {
        if (!playerName.trim()) {
            triggerShake();
            return;
        }

        const code = generateRoomCode();
        setIsCreator(true);
        resetRun();

        const connected = await subscribeToRoom(code, true);
        if (!connected) return;

        setGameState('waiting-room');
        await publishRoomEvent('player-joined', { name: playerName.trim(), joinedAt: Date.now() });
    };

    const joinRoom = async () => {
        if (!playerName.trim()) {
            triggerShake();
            return;
        }

        const normalized = normalizeRoomCode(joinCode);
        if (normalized.length !== ROOM_CODE_LENGTH) {
            setRoomError('Enter a valid 5-character room code.');
            triggerShake();
            return;
        }

        setIsCreator(false);
        resetRun();

        const connected = await subscribeToRoom(normalized, false);
        if (!connected) return;

        setGameState('joining-room');
        await publishRoomEvent('player-joined', { name: playerName.trim(), joinedAt: Date.now() });
        setTimeout(() => {
            if (gameStateRef.current === 'joining-room') {
                startPlaying();
            }
        }, 500);
    };

    const copyRoomCode = async () => {
        if (!roomCode) return;
        try {
            await navigator.clipboard.writeText(roomCode);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Clipboard write failed:', err);
        }
    };

    const returnToLobby = () => {
        cleanupRoom(true);
        setGameState('landing');
        setCurrentRound(1);
        setScores([]);
        setPromptText('');
        setRoundResult(null);
        setApiError('');
        localStorage.removeItem(GAME_SESSION_KEY);
    };

    const fetchImageAsBase64 = async (imagePath) => {
        const response = await fetch(imagePath);
        if (!response.ok) throw new Error("Image not found");
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64data = reader.result.split(',')[1];
                resolve({
                    mimeType: blob.type || 'image/jpeg',
                    data: base64data
                });
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    };

    const submitPrompt = async (e) => {
        e.preventDefault();
        if (!promptText.trim()) {
            triggerShake();
            if (textareaRef.current) textareaRef.current.focus();
            return;
        }
        if (!GEMINI_API_KEY) {
            setApiError("Configuration Error: Gemini API Key is missing.");
            return;
        }

        setIsLoading(true);
        setApiError('');

        try {
            const imagePath = `/images/image${currentRound}.png`;
            const base64Image = await fetchImageAsBase64(imagePath);

            const payload = {
                contents: [
                    {
                        parts: [
                            { text: `You are a judge for a prompt-writing game. The player was shown this image and wrote: '${promptText}'. Score 0-100 based on accuracy, detail, and descriptiveness. Respond ONLY with valid JSON, no markdown: {"score": <number>, "feedback": "<one sentence>"}` },
                            {
                                inline_data: {
                                    mime_type: base64Image.mimeType,
                                    data: base64Image.data
                                }
                            }
                        ]
                    }
                ]
            };

            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`API returned ${response.status}`);
            }

            const result = await response.json();
            const textResponse = result.candidates[0].content.parts[0].text.trim();

            let cleanJson = textResponse.replace(/^```(json)?\s*/i, '').replace(/```$/i, '').trim();
            const parsed = JSON.parse(cleanJson);

            let finalScore = Math.max(0, Math.min(100, Number(parsed.score) || 0));
            const totalSoFar = getTotal(scoresRef.current.map((s) => s.score)) + finalScore;

            await publishRoomEvent('round-complete', {
                name: playerNameRef.current,
                round: currentRound,
                score: finalScore,
                totalSoFar,
            });

            setRoundResult({
                score: finalScore,
                feedback: parsed.feedback || "Good effort."
            });

        } catch (err) {
            setApiError("Validation error. Ensure API keys are correct or try reloading.");
            console.error(err);
        } finally {
            setIsLoading(false);
        }
    };

    const handleNextRound = () => {
        const newScores = [...scores, { round: currentRound, ...roundResult }];
        setScores(newScores);
        setRoundResult(null);
        setPromptText('');
        setApiError('');

        if (currentRound < TOTAL_ROUNDS) {
            setCurrentRound(currentRound + 1);
        } else {
            const finalRoundScores = newScores.map((s) => s.score);
            const totalScore = getTotal(finalRoundScores);

            publishRoomEvent('game-complete', {
                name: playerNameRef.current,
                scores: finalRoundScores,
                total: totalScore,
            });

            if (opponentFinishedRef.current) {
                toVersusFinal(opponentScoresRef.current, opponentTotalRef.current);
            } else {
                setGameState('waiting-finish');
            }
        }
    };

    const playAgain = () => {
        returnToLobby();
    };

    const getScoreColorClass = (score) => {
        if (score >= 80) return 'score-high';
        if (score >= 50) return 'score-mid';
        return 'score-low';
    };

    // ---------------------------------------------------------------------------
    // RENDER COMPONENTS
    // ---------------------------------------------------------------------------

    const localCumulative = getTotal(scores.map((s) => s.score)) + (roundResult ? roundResult.score : 0);

    if (gameState === 'landing') {
        return (
            <div className="container landing-layout">
                <div className="landing-form-panel">
                    <div className="logo">
                        <h2>PROMPT</h2>
                        <h2>CRAFT <span className="logo-star">✦</span></h2>
                    </div>
                    <p className="subtitle">Describe the image perfectly. Let AI judge you.</p>

                    <form className={`landing-form ${shake ? 'shake' : ''}`} onSubmit={(e) => e.preventDefault()}>
                        <label htmlFor="playerName">Enter Player Name</label>
                        <input
                            id="playerName"
                            type="text"
                            placeholder="e.g. MasterCrafter"
                            value={playerName}
                            onChange={(e) => setPlayerName(e.target.value)}
                            autoComplete="off"
                        />

                        <div className="room-actions">
                            <button type="button" className="btn-primary" onClick={createRoom}>Create Room</button>
                            <button type="button" className="btn-primary btn-secondary" onClick={joinRoom}>Join Room</button>
                        </div>

                        <div className="join-room-row">
                            <input
                                type="text"
                                placeholder="Enter room code"
                                value={joinCode}
                                onChange={(e) => setJoinCode(normalizeRoomCode(e.target.value))}
                                autoComplete="off"
                            />
                            <button type="button" className="btn-primary btn-join" onClick={joinRoom}>Join</button>
                        </div>

                        {roomError && <p className="room-error">{roomError}</p>}
                    </form>
                </div>

                <div className="leaderboard-panel card">
                    <h3>Leaderboard</h3>
                    <div className="leaderboard-list">
                        {leaderboard.length === 0 ? (
                            <p className="muted text-center" style={{ marginTop: '2rem' }}>No scores yet. Be the first!</p>
                        ) : (
                            leaderboard.map((entry, idx) => (
                                <div key={idx} className="leaderboard-item">
                                    <div className="lb-rank">
                                        {idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`}
                                    </div>
                                    <div className="lb-name">{entry.name}</div>
                                    <div className="lb-score">{entry.score}</div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        );
    }

    if (gameState === 'waiting-room' || gameState === 'joining-room') {
        return (
            <div className="container final-layout">
                <div className="card waiting-card animate-reveal">
                    <h3 className="mono-heading text-center">Matchmaking</h3>

                    {gameState === 'waiting-room' && (
                        <>
                            <div className="room-code-row">
                                <div className="room-code-display">{roomCode}</div>
                                <button type="button" className="copy-code-btn" onClick={copyRoomCode}>
                                    {copied ? 'Copied ✓' : 'Copy Code'}
                                </button>
                            </div>
                            <p className="muted text-center">Share this room code with your opponent.</p>
                        </>
                    )}

                    <p className="waiting-text">Waiting for opponent<span className="waiting-dots">...</span></p>

                    {roomError && <p className="room-error text-center">{roomError}</p>}

                    {opponentLeft ? (
                        <button type="button" className="btn-primary" onClick={returnToLobby}>Return To Lobby</button>
                    ) : (
                        <button type="button" className="btn-primary btn-secondary" onClick={returnToLobby}>Cancel</button>
                    )}
                </div>
            </div>
        );
    }

    if (gameState === 'playing') {
        return (
            <div className="container round-layout-shell">
                <div className="round-status-bar">
                    <span>You: {localCumulative}</span>
                    <span className="status-divider">·</span>
                    <span>{opponentName || 'Opponent'}: {opponentRound > 0 ? opponentTotal : 'playing...'}</span>
                </div>

                {disconnectedBanner && (
                    <div className="disconnect-banner">
                        <span>Opponent disconnected.</span>
                        <button onClick={() => setDisconnectedBanner(false)} className="btn-close">×</button>
                    </div>
                )}

                {apiError && (
                    <div className="error-banner">
                        <span>{apiError}</span>
                        <button onClick={() => setApiError('')} className="btn-close">×</button>
                    </div>
                )}

                <div className="round-layout">
                    <div className="image-panel">
                        <div className="progress-pips">
                            {Array.from({ length: TOTAL_ROUNDS }).map((_, idx) => (
                                <div
                                    key={idx}
                                    className={`pip ${idx + 1 === currentRound ? 'active' : ''} ${idx + 1 < currentRound ? 'completed' : ''}`}
                                />
                            ))}
                            <span className="round-counter">ROUND {currentRound}/{TOTAL_ROUNDS}</span>
                        </div>

                        <div className="image-wrapper">
                            <img src={`/images/image${currentRound}.png`} alt={`Round ${currentRound}`} className="round-image" />

                            {roundResult && (
                                <div className="score-overlay animate-reveal">
                                    <div className="score-content">
                                        <span className="score-label">SCORE</span>
                                        <div className={`score-number ${getScoreColorClass(roundResult.score)}`}>
                                            {roundResult.score}
                                        </div>
                                        <p className="score-feedback">{roundResult.feedback}</p>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="prompt-panel card">
                        <h3 className="mono-heading">Your Prompt</h3>

                        {!roundResult ? (
                            <form onSubmit={submitPrompt} className={`prompt-form ${shake ? 'shake' : ''}`}>
                                <textarea
                                    ref={textareaRef}
                                    placeholder="Describe every detail you see..."
                                    value={promptText}
                                    onChange={(e) => setPromptText(e.target.value)}
                                    disabled={isLoading}
                                />
                                <button
                                    type="submit"
                                    className={`btn-primary ${isLoading ? 'loading' : ''}`}
                                    disabled={isLoading}
                                >
                                    {isLoading ? <span className="spinner"></span> : 'Submit Prompt'}
                                </button>
                            </form>
                        ) : (
                            <div className="prompt-result-view">
                                <div className="prompt-echo">
                                    "{promptText}"
                                </div>
                                <button onClick={handleNextRound} className="btn-primary animate-fade-in">
                                    {currentRound === TOTAL_ROUNDS ? 'Finish Game' : 'Next Round'}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    if (gameState === 'waiting-finish') {
        const ownTotal = getTotal(scores.map((s) => s.score));

        return (
            <div className="container final-layout">
                <div className="card waiting-finish-card animate-reveal">
                    <h3 className="mono-heading text-center">Round Complete</h3>
                    <h2 className="text-center" style={{ marginTop: '1rem' }}>Waiting for {opponentName || 'opponent'} to finish...</h2>
                    <p className="waiting-text">Syncing match result<span className="waiting-dots">...</span></p>

                    <div className="waiting-stats">
                        <p>Your total: <span className="text-accent">{ownTotal}</span></p>
                        <p>Opponent is on round {Math.max(1, opponentRound)} / {TOTAL_ROUNDS}</p>
                    </div>

                    {roomError && <p className="room-error text-center">{roomError}</p>}

                    {opponentLeft ? (
                        <button type="button" className="btn-primary" onClick={returnToLobby}>Return To Lobby</button>
                    ) : (
                        <button type="button" className="btn-primary btn-secondary" onClick={returnToLobby}>Leave</button>
                    )}
                </div>
            </div>
        );
    }

    if (gameState === 'versus-final') {
        const localRoundScores = Array.from({ length: TOTAL_ROUNDS }, (_, idx) => Number(scores[idx]?.score ?? 0));
        const otherRoundScores = Array.from({ length: TOTAL_ROUNDS }, (_, idx) => Number(opponentScores[idx] ?? 0));
        const localTotal = getTotal(localRoundScores);
        const otherTotal = getTotal(otherRoundScores);
        const isTie = localTotal === otherTotal;
        const localWins = localTotal > otherTotal;
        const winnerName = isTie ? '' : localWins ? playerName : (opponentName || 'Opponent');

        return (
            <div className="container final-layout">
                <div className="card final-card versus-card animate-reveal">
                    <div className="logo small">
                        <h2>PROMPT CRAFT VERSUS <span className="logo-star">✦</span></h2>
                    </div>

                    <div className="versus-grid">
                        <div className={`versus-player-card ${localWins ? 'winner' : !isTie ? 'loser' : ''}`}>
                            <h3>{playerName}</h3>
                            <p className="versus-total">total: {localTotal}</p>
                            <div className="versus-round-row">
                                {localRoundScores.map((score, idx) => (
                                    <span key={`l-${idx}`} className={`round-pill ${score > otherRoundScores[idx] ? 'better' : ''}`}>R{idx + 1}: {score}</span>
                                ))}
                            </div>
                        </div>

                        <div className="versus-vs">VS</div>

                        <div className={`versus-player-card ${!localWins && !isTie ? 'winner' : !isTie ? 'loser' : ''}`}>
                            <h3>{opponentName || 'Opponent'}</h3>
                            <p className="versus-total">total: {otherTotal}</p>
                            <div className="versus-round-row">
                                {otherRoundScores.map((score, idx) => (
                                    <span key={`o-${idx}`} className={`round-pill ${score > localRoundScores[idx] ? 'better' : ''}`}>R{idx + 1}: {score}</span>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="round-compare-wrap">
                        {Array.from({ length: TOTAL_ROUNDS }).map((_, idx) => (
                            <div key={idx} className="round-compare-row">
                                <span className="mono-label">R{idx + 1}</span>
                                <span className={localRoundScores[idx] > otherRoundScores[idx] ? 'score-high' : ''}>{localRoundScores[idx]}</span>
                                <span className={otherRoundScores[idx] > localRoundScores[idx] ? 'score-high' : ''}>{otherRoundScores[idx]}</span>
                            </div>
                        ))}
                    </div>

                    <h3 className="versus-winner-text">
                        {isTie ? "IT'S A TIE!" : `${winnerName} WINS!`}
                    </h3>

                    <div className="versus-actions">
                        <button onClick={playAgain} className="btn-primary">Play Again</button>
                        <button onClick={returnToLobby} className="btn-primary btn-secondary">Leave</button>
                    </div>
                </div>
            </div>
        );
    }

    return null;
}
