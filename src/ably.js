import Ably from 'ably';

export const ably = new Ably.Realtime(import.meta.env.VITE_ABLY_API_KEY);
