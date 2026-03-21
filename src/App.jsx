import React, { useState, useEffect, useRef } from 'react';

const TOTAL_ROUNDS = 7;
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const GAME_SESSION_KEY = 'promptcraft_game_session';

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
    const [gameState, setGameState] = useState(() => getSavedSession()?.gameState || 'landing'); // 'landing', 'playing', 'final'
    const [playerName, setPlayerName] = useState(() => getSavedSession()?.playerName || '');
    const [currentRound, setCurrentRound] = useState(() => getSavedSession()?.currentRound || 1);
    const [scores, setScores] = useState(() => getSavedSession()?.scores || []); // { round, score, feedback }
    const [leaderboard, setLeaderboard] = useState([]);

    const [promptText, setPromptText] = useState(() => getSavedSession()?.promptText || '');
    const [isLoading, setIsLoading] = useState(false);
    const [apiError, setApiError] = useState('');
    const [roundResult, setRoundResult] = useState(() => getSavedSession()?.roundResult || null); // { score, feedback }

    const [shake, setShake] = useState(false);
    const textareaRef = useRef(null);

    useEffect(() => {
        const session = {
            gameState,
            playerName,
            currentRound,
            scores,
            promptText,
            roundResult
        };
        localStorage.setItem(GAME_SESSION_KEY, JSON.stringify(session));
    }, [gameState, playerName, currentRound, scores, promptText, roundResult]);

    useEffect(() => {
        loadLeaderboard();
    }, [gameState]); // reload when reaching landing page etc.

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

    const startGame = (e) => {
        e.preventDefault();
        if (!playerName.trim()) {
            triggerShake();
            return;
        }
        setGameState('playing');
        setCurrentRound(1);
        setScores([]);
        setPromptText('');
        setRoundResult(null);
        setApiError('');
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
            const totalScore = newScores.reduce((acc, curr) => acc + curr.score, 0);
            saveToLeaderboard(playerName, totalScore);
            setGameState('final');
        }
    };

    const playAgain = () => {
        setPlayerName('');
        setGameState('landing');
        setCurrentRound(1);
        setScores([]);
        setPromptText('');
        setRoundResult(null);
        setApiError('');
        localStorage.removeItem(GAME_SESSION_KEY);
    };

    const getScoreColorClass = (score) => {
        if (score >= 80) return 'score-high';
        if (score >= 50) return 'score-mid';
        return 'score-low';
    };

    // ---------------------------------------------------------------------------
    // RENDER COMPONENTS
    // ---------------------------------------------------------------------------

    if (gameState === 'landing') {
        return (
            <div className="container landing-layout">
                <div className="landing-form-panel">
                    <div className="logo">
                        <h2>PROMPT</h2>
                        <h2>CRAFT <span className="logo-star">✦</span></h2>
                    </div>
                    <p className="subtitle">Describe the image perfectly. Let AI judge you.</p>

                    <form onSubmit={startGame} className={`landing-form ${shake ? 'shake' : ''}`}>
                        <label htmlFor="playerName">Enter Player Name</label>
                        <input
                            id="playerName"
                            type="text"
                            placeholder="e.g. MasterCrafter"
                            value={playerName}
                            onChange={(e) => setPlayerName(e.target.value)}
                            autoComplete="off"
                        />
                        <button type="submit" className="btn-primary">Start Game</button>
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

    if (gameState === 'playing') {
        return (
            <div className="container round-layout">
                {apiError && (
                    <div className="error-banner">
                        <span>{apiError}</span>
                        <button onClick={() => setApiError('')} className="btn-close">×</button>
                    </div>
                )}

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
        );
    }

    if (gameState === 'final') {
        const totalScore = scores.reduce((acc, curr) => acc + curr.score, 0);
        const avgScore = totalScore > 0 ? Math.round(totalScore / TOTAL_ROUNDS) : 0;

        return (
            <div className="container final-layout">
                <div className="card final-card animate-reveal">
                    <div className="logo small">
                        <h2>PROMPT CRAFT <span className="logo-star">✦</span></h2>
                    </div>
                    <h3 className="mono-heading text-center" style={{ marginTop: '2rem' }}>Game Over, {playerName}</h3>

                    <div className="final-score-display">
                        <span className="final-label">TOTAL SCORE</span>
                        <div className="final-number text-accent">{totalScore}</div>
                        <span className="final-avg">Avg: {avgScore} / 100 per round</span>
                    </div>

                    <div className="rounds-grid">
                        {scores.map((s, idx) => (
                            <div key={idx} className="round-summary-item">
                                <span className="mono-label">R{s.round}</span>
                                <span className={`mono-val ${getScoreColorClass(s.score)}`}>{s.score}</span>
                            </div>
                        ))}
                    </div>

                    <button onClick={playAgain} className="btn-primary btn-block" style={{ marginTop: '2rem' }}>
                        Play Again
                    </button>
                </div>
            </div>
        );
    }

    return null;
}
