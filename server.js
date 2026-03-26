require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();

// Güvenlik duvarları (Helmet ve Sanitize) tamamen kaldırıldı!
app.use(cors());
app.use(express.json());

// public klasöründeki index.html'i internete sunar
app.use(express.static(path.join(__dirname, 'public')));

// GÜVENLİK: Sadece Spam Koruması aktif (1 dakikada 20 istek)
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 20, 
    message: { success: false, message: "Çok fazla istek attınız. Lütfen 1 dakika bekleyin." },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', apiLimiter);

const API_KEY = process.env.RIOT_API_KEY;
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB veritabanına başarıyla bağlanıldı!'))
    .catch((err) => console.error('❌ MongoDB bağlantı hatası:', err));

const playerSchema = new mongoose.Schema({
    puuid: { type: String, required: true, unique: true },
    gameName: String,
    tagLine: String,
    mmr: { type: Number, default: 1200 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    processedMatches: { type: [String], default: [] }
});
const Player = mongoose.model('Player', playerSchema);

const REGIONAL_URL = 'https://europe.api.riotgames.com';

app.get('/api/get-player/:gameName/:tagLine', async (req, res) => {
    const gameName = req.params.gameName.trim();
    const tagLine = req.params.tagLine.trim();

    try {
        const response = await axios.get(
            `${REGIONAL_URL}/riot/account/v1/accounts/by-riot-id/${encodeURI(gameName)}/${encodeURI(tagLine)}`,
            { headers: { 'X-Riot-Token': API_KEY } }
        );
        
        let player = await Player.findOne({ puuid: response.data.puuid });
        if (!player) {
            player = new Player({
                puuid: response.data.puuid,
                gameName: response.data.gameName,
                tagLine: response.data.tagLine
            });
            await player.save();
        }
        res.json({ success: true, puuid: response.data.puuid, gameName: response.data.gameName, tagLine: response.data.tagLine });
    } catch (error) {
        res.status(500).json({ success: false, message: "Oyuncu bulunamadı." });
    }
});

app.get('/api/get-aram-mmr/:puuid', async (req, res) => {
    const puuid = String(req.params.puuid); 
    try {
        let player = await Player.findOne({ puuid: puuid });
        if (!player) return res.status(404).json({ success: false, message: "Oyuncu bulunamadı." });

        const matchIdsResponse = await axios.get(
            `${REGIONAL_URL}/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=450&start=0&count=10`,
            { headers: { 'X-Riot-Token': API_KEY } }
        );
        const fetchedMatchIds = matchIdsResponse.data;
        const newMatches = fetchedMatchIds.filter(id => !player.processedMatches.includes(id));

        for (const matchId of newMatches) {
            const matchDetail = await axios.get(
                `${REGIONAL_URL}/lol/match/v5/matches/${matchId}`,
                { headers: { 'X-Riot-Token': API_KEY } }
            );
            const participant = matchDetail.data.info.participants.find(p => p.puuid === puuid);
            if (participant) {
                if (participant.win) {
                    player.mmr += 20; player.wins += 1;
                } else {
                    player.mmr -= 15; player.losses += 1;
                }
                player.processedMatches.push(matchId); 
            }
        }

        if (newMatches.length > 0) await player.save();

        const totalMatches = player.wins + player.losses;
        const winRate = totalMatches === 0 ? 0 : Math.round((player.wins / totalMatches) * 100);

        res.json({ success: true, wins: player.wins, losses: player.losses, winRate: `%${winRate}`, estimatedMMR: player.mmr });
    } catch (error) {
        res.status(500).json({ success: false, message: "Veriler çekilemedi." });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const topPlayers = await Player.find().sort({ mmr: -1 }).limit(10);
        res.json({ success: true, leaderboard: topPlayers });
    } catch (error) {
        res.status(500).json({ success: false, message: "Sıralama tablosu alınamadı." });
    }
});

// Yanlış linke girilirse ana sayfaya yönlendir
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`ARAM Ranked sunucusu çalışıyor! Port: ${PORT} (Engeller Kaldırıldı 🚀)`);
});