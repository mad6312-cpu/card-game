const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const CARD_DECK = [
    {
        id: 'wood_shield',
        name: '木の盾',
        category: 'DEFENSE',
        image: '/images/wood_shield.png',
        desc: '攻撃: 同点以上または下位全員から選択(差に応じた命中率/ヒットで-3000&選択不可&中断) / 防御: 攻撃を1度無効'
    },
    {
        id: 'wood_shield_set',
        name: '木の盾セット',
        category: 'DEFENSE',
        image: '/images/wood_shield_set.png',
        desc: '攻撃: 同点以上または下位全員(差に応じた命中率/順次判定/ヒット・無効化で回数消費) / 防御: 攻撃を無効(計3回で破棄)'
    },
    {
        id: 'wood_sword',
        name: '木の剣',
        category: 'ATTACK',
        image: '/images/wood_sword.png',
        desc: '攻撃: 自分より上位なら単体(5000点差以内/成功率1/2)、下位なら全員順次判定(成功率1/2) / 防御: 攻撃を1度無効(高得点者からの攻撃は無効化不可)'
    },
    {
        id: 'gold_bag',
        name: '金袋',
        category: 'SCORE',
        image: '/images/gold_bag.png',
        desc: '自分の得点+3000'
    },
    {
        id: 'disaster',
        name: '大災害',
        category: 'ATTACK',
        image: '/images/disaster.png',
        desc: '使用者以外全員対象(命中100%)。手札/防御カード全破棄。1位:-6000/2位:-4000/3位:-2000/4位:-1000。ダメージ対象は選択不可(1巡分)付与。'
    },
    {
        id: 'invincible_armor',
        name: '無敵アーマー',
        category: 'SPECIAL',
        image: '/images/invincible_armor.png',
        desc: '特殊カード: 使用から合計4ターン経過まで「無敵状態」になる。防御カードセット時は使用不可。使用時手札から破棄。'
    },
    {
        id: 'dark_matter',
        name: 'ダークマター',
        category: 'SPECIAL',
        image: '/images/dark_matter.png',
        desc: '特殊: 次の自分ターンまで無敵状態付与＆+5000点。使用前と同点、または使用後に追いついた/逆転した相手(無敵・選択不可除く)の手札・防御カード全破棄＆-3000点＆選択不可(2ターン)付与。'
    }
];

let cardSettings = {
    gold_bag: true,
    wood_sword: true,
    wood_shield: true,
    wood_shield_set: true,
    disaster: true,
    invincible_armor: true,
    dark_matter: true // ★追加
};

function createInitialState() {
    return {
        started: false,
        players: {},
        turnOrder: [],
        currentTurnPlayerId: null,
        actedPlayerIds: [],
        round: 1,
        turnPhase: 'WAITING',
        draft: {
            phase: 'SELECTING',
            choices: {},
            availableScores: [5000, 1000, -1000, -5000],
            timer: null
        }
    };
}

let gameState = createInitialState();

function getRandomAvailableCard(player) {
    let availableCards = CARD_DECK.filter(c => cardSettings[c.id] !== false);

    if (player) {
        const hasShieldSetInHand = player.hand && player.hand.some(c => c.id === 'wood_shield_set');
        const hasShieldSetInDefense = player.defenseCard && player.defenseCard.card && player.defenseCard.card.id === 'wood_shield_set';

        if (hasShieldSetInHand || hasShieldSetInDefense) {
            availableCards = availableCards.filter(c => c.id !== 'wood_shield_set');
        }
    }

    const pool = availableCards.length > 0 ? availableCards : CARD_DECK;
    const template = pool[Math.floor(Math.random() * pool.length)];
    return {
        ...template,
        instanceId: 'card_' + Date.now() + '_' + Math.floor(Math.random() * 1000)
    };
}

// --- サーバー側に状態変数を追加 ---
let skipBonusModal = true; // 初期値: ON

io.on('connection', (socket) => {
    console.log('接続:', socket.id);
    const playerKeys = Object.keys(gameState.players);

    if (playerKeys.length < 4 && !gameState.started) {
        const pNum = playerKeys.length + 1;
        gameState.players[socket.id] = {
            id: socket.id,
            number: pNum,
            name: `P${pNum}`,
            score: 25000,
            prevScore: 25000,
            scoreChange: 0,
            hand: [],
            defenseCard: null,
            draftResolved: false,
            immunityCount: 0,
            invincibleTurns: 0
        };

        socket.emit('init', { playerNumber: pNum, id: socket.id });
        io.emit('playerUpdate', { playerCount: Object.keys(gameState.players).length });
        socket.emit('updateCardSettings', cardSettings);

        if (Object.keys(gameState.players).length === 4) {
            skipDraftAndStartGame();
        }
    } else {
        socket.emit('full');
    }

    socket.on('debugUpdateScore', ({ targetPlayerId, amount, setDirect }) => {
        const target = gameState.players[targetPlayerId];
        if (!target) return;

        resetScoreChanges();
        target.prevScore = target.score;

        if (setDirect) {
            const newScore = Number(amount);
            target.scoreChange = newScore - target.score;
            target.score = newScore;
        } else {
            target.scoreChange = Number(amount);
            target.score += Number(amount);
        }

        broadcastGameState(`[デバッグ] P${target.number} の得点が ${target.score} 点に変更されました。`);
    });

    socket.on('debugDrawCard', ({ targetPlayerId }) => {
        const target = gameState.players[targetPlayerId];
        if (!target) return;

        resetScoreChanges();

        // 制限を無視して山札からカードを1枚引く
        const randomCard = getRandomAvailableCard(target);
        target.hand.push(randomCard);

        broadcastGameState(`[デバッグ] P${target.number} が山札から「${randomCard.name}」をドローしました。`);
    });

    socket.on('toggleCardSetting', ({ cardId, enabled }) => {
        if (cardSettings.hasOwnProperty(cardId)) {
            cardSettings[cardId] = enabled;
            io.emit('updateCardSettings', cardSettings);
        }
    });

    socket.on('selectDraftScore', (score) => {
        if (gameState.started || gameState.draft.phase === 'FINISHED') return;
        const player = gameState.players[socket.id];
        if (!player || player.draftResolved) return;

        gameState.draft.choices[socket.id] = Number(score);
        const unresolvedIds = Object.keys(gameState.players).filter(id => !gameState.players[id].draftResolved);
        const answeredCount = unresolvedIds.filter(id => gameState.draft.choices[id] !== undefined).length;

        if (answeredCount >= unresolvedIds.length) {
            if (gameState.draft.timer) clearTimeout(gameState.draft.timer);
            resolveDraft();
        }
    });

    // ★追加: 接続時に現在のモーダルスキップ設定を送信
    socket.emit('updateBonusSkipSetting', skipBonusModal);

    // ★追加: 誰かがスキップ設定を切り替えた際の同期イベント
    socket.on('toggleBonusSkipSetting', (enabled) => {
        skipBonusModal = enabled;
        // 全プレイヤー（送信者含む）に新しい設定を一括同期
        io.emit('updateBonusSkipSetting', skipBonusModal);
    });

    socket.on('chooseBonus', (acceptBonus) => {
        resetScoreChanges();
        const currentTurnId = gameState.currentTurnPlayerId;
        if (socket.id !== currentTurnId || gameState.turnPhase !== 'BONUS_CHOICE') return;

        const player = gameState.players[socket.id];
        if (acceptBonus) applyScoreChange(player, 3000);
        const randomCard = getRandomAvailableCard(player);
        player.hand.push(randomCard);

        gameState.turnPhase = 'MAIN';

        const bonusLog = acceptBonus ? ' (+3000点獲得)' : '';

        socket.emit('syncGameState', {
            players: gameState.players,
            turnOrder: gameState.turnOrder,
            currentTurnPlayerId: gameState.currentTurnPlayerId,
            round: gameState.round,
            turnPhase: gameState.turnPhase,
            log: `「${randomCard.name}」を獲得しました。${bonusLog}`
        });

        socket.broadcast.emit('syncGameState', {
            players: gameState.players,
            turnOrder: gameState.turnOrder,
            currentTurnPlayerId: gameState.currentTurnPlayerId,
            round: gameState.round,
            turnPhase: gameState.turnPhase,
            log: `P${player.number} がカードを1枚獲得しました。${bonusLog}`
        });
    });

    socket.on('playCard', ({ instanceId, actionTarget, targetPlayerId, attackCount }) => {
        resetScoreChanges();

        const currentTurnId = gameState.currentTurnPlayerId;
        if (socket.id !== currentTurnId || gameState.turnPhase !== 'MAIN') {
            socket.emit('errorMessage', 'あなたのターンのメインフェーズではありません。');
            return;
        }

        const player = gameState.players[socket.id];
        const cardIndex = player.hand.findIndex(c => String(c.instanceId) === String(instanceId));
        if (cardIndex === -1) {
            socket.emit('errorMessage', 'エラー: カードが見つかりません。');
            return;
        }

        const card = player.hand[cardIndex];

        if (player.defenseCard && !card.allowWithDefense) {
            socket.emit('errorMessage', '防御カードがセットされています。');
            return;
        }

        if (card.id === 'gold_bag') {
            applyScoreChange(player, 3000);
            player.hand.splice(cardIndex, 1);
            broadcastGameState(`P${player.number} が「金袋」を使用し、+3000点獲得しました！`);
        } else if (card.id === 'disaster') {
            player.hand.splice(cardIndex, 1);
            executeDisasterAttack(socket.id);
        } else if (card.id === 'invincible_armor') {
            player.invincibleTurns = 4;
            player.invincibleSource = 'ARMOR'; // ★追加: 無敵ソースの識別
            player.hand.splice(cardIndex, 1);

            socket.emit('syncGameState', {
                players: gameState.players,
                turnOrder: gameState.turnOrder,
                currentTurnPlayerId: gameState.currentTurnPlayerId,
                round: gameState.round,
                turnPhase: gameState.turnPhase,
                log: `「無敵アーマー」を使用しました。4ターンの間「無敵状態」になります。`
            });

            socket.broadcast.emit('syncGameState', {
                players: gameState.players,
                turnOrder: gameState.turnOrder,
                currentTurnPlayerId: gameState.currentTurnPlayerId,
                round: gameState.round,
                turnPhase: gameState.turnPhase,
                log: ''
            });
        } else if (card.id === 'dark_matter') { // ★追加
            player.hand.splice(cardIndex, 1);
            executeDarkMatter(socket.id);
        } else if (actionTarget === 'ATTACK') {
            if (!targetPlayerId) {
                socket.emit('errorMessage', '攻撃対象を選択してください。');
                return;
            }

            if (card.id === 'wood_shield' && (targetPlayerId === 'EQUAL_OR_HIGHER' || targetPlayerId === 'LOWER')) {
                player.hand.splice(cardIndex, 1);
                executeWoodShieldGroupAttack(socket.id, targetPlayerId);
            } else if (card.id === 'wood_shield_set' && (targetPlayerId === 'EQUAL_OR_HIGHER' || targetPlayerId === 'LOWER')) {
                let cardObj = player.hand[cardIndex];
                if (!cardObj.usesLeft) cardObj.usesLeft = 3;
                const requestedCount = Math.min(Math.max(Number(attackCount) || 1, 1), 3);
                const maxAttacks = Math.min(requestedCount, cardObj.usesLeft);

                executeShieldSetGroupAttack(socket.id, targetPlayerId, cardObj, maxAttacks, () => {
                    if (cardObj.usesLeft <= 0) {
                        const idx = player.hand.findIndex(c => String(c.instanceId) === String(cardObj.instanceId));
                        if (idx !== -1) {
                            player.hand.splice(idx, 1);
                        }
                    }
                    broadcastGameState();
                });
            } else if (card.id === 'wood_sword' && targetPlayerId === 'ALL_LOWER') {
                player.hand.splice(cardIndex, 1);
                executeWoodSwordAttack(socket.id, targetPlayerId);
            } else {
                const target = gameState.players[targetPlayerId];
                if (!target) {
                    socket.emit('errorMessage', '対象となるプレイヤーが見つかりません。');
                    return;
                }

                if (target.immunityCount && target.immunityCount > 0) {
                    socket.emit('errorMessage', `${target.name} は現在「選択不可状態」のため攻撃できません。`);
                    return;
                }

                if (gameState.round === 1) {
                    const myOrderIndex = gameState.turnOrder.indexOf(socket.id);
                    const targetOrderIndex = gameState.turnOrder.indexOf(targetPlayerId);
                    if (targetOrderIndex > myOrderIndex) {
                        socket.emit('errorMessage', '1巡目は自分より後に行動するプレイヤーを攻撃できません。');
                        return;
                    }
                }

                if (card.id === 'wood_sword') {
                    player.hand.splice(cardIndex, 1);
                    executeWoodSwordAttack(socket.id, targetPlayerId);
                } else if (card.id === 'wood_shield_set') {
                    let cardObj = player.hand[cardIndex];
                    if (!cardObj.usesLeft) cardObj.usesLeft = 3;

                    const requestedCount = Math.min(Math.max(Number(attackCount) || 1, 1), 3);
                    const actualAttacks = Math.min(requestedCount, cardObj.usesLeft);

                    executeShieldSetAttack(socket.id, targetPlayerId, cardObj, actualAttacks, () => {
                        if (cardObj.usesLeft <= 0) {
                            const idx = player.hand.findIndex(c => String(c.instanceId) === String(cardObj.instanceId));
                            if (idx !== -1) {
                                player.hand.splice(idx, 1);
                            }
                        }
                        broadcastGameState();
                    });
                } else {
                    player.hand.splice(cardIndex, 1);
                    executeStandardAttack(socket.id, targetPlayerId, card.id);
                }
            }
        } else if (actionTarget === 'DEFENSE') {
            if (player.defenseCard) {
                socket.emit('errorMessage', '防御カードはすでにセットされています。');
                return;
            }

            let uses = 1;
            if (card.id === 'wood_shield_set') {
                if (!card.usesLeft) card.usesLeft = 3;
                uses = card.usesLeft;
            }

            player.defenseCard = { card, usesLeft: uses };
            player.hand.splice(cardIndex, 1);
            broadcastGameState(`P${player.number} が防御カード「${card.name}」をセットしました。`);
        }
    });

    socket.on('playDefenseAsAttack', ({ targetPlayerId, attackCount }) => {
        resetScoreChanges();
        const currentTurnId = gameState.currentTurnPlayerId;
        if (socket.id !== currentTurnId || gameState.turnPhase !== 'MAIN') {
            socket.emit('errorMessage', 'メインフェーズでのみ使用できます。');
            return;
        }

        const player = gameState.players[socket.id];
        if (!player.defenseCard) {
            socket.emit('errorMessage', 'セットされている防御カードがありません。');
            return;
        }

        const defObj = player.defenseCard;
        const card = defObj.card;

        if (card.id === 'wood_shield' && (targetPlayerId === 'EQUAL_OR_HIGHER' || targetPlayerId === 'LOWER')) {
            player.defenseCard = null;
            executeWoodShieldGroupAttack(socket.id, targetPlayerId);
            return;
        }

        if (card.id === 'wood_shield_set' && (targetPlayerId === 'EQUAL_OR_HIGHER' || targetPlayerId === 'LOWER')) {
            const requestedCount = Math.min(Math.max(Number(attackCount) || 1, 1), 3);
            const maxAttacks = Math.min(requestedCount, defObj.usesLeft);

            executeShieldSetGroupAttack(socket.id, targetPlayerId, defObj, maxAttacks, () => {
                card.usesLeft = defObj.usesLeft;
                if (defObj.usesLeft <= 0) {
                    player.defenseCard = null;
                }
                broadcastGameState();
            });
            return;
        }

        if (!targetPlayerId || !gameState.players[targetPlayerId] || targetPlayerId === socket.id) {
            socket.emit('errorMessage', '攻撃対象を選択してください。');
            return;
        }

        const target = gameState.players[targetPlayerId];
        if (target.immunityCount && target.immunityCount > 0) {
            socket.emit('errorMessage', `${target.name} は現在「選択不可状態」のため攻撃できません。`);
            return;
        }

        if (gameState.round === 1) {
            const myOrderIndex = gameState.turnOrder.indexOf(socket.id);
            const targetOrderIndex = gameState.turnOrder.indexOf(targetPlayerId);
            if (targetOrderIndex > myOrderIndex) {
                socket.emit('errorMessage', '1巡目は自分より後に行動するプレイヤーを攻撃できません。');
                return;
            }
        }

        if (card.id === 'wood_shield_set') {
            const requestedCount = Math.min(Math.max(Number(attackCount) || 1, 1), 3);
            const actualAttacks = Math.min(requestedCount, defObj.usesLeft);

            executeShieldSetAttack(socket.id, targetPlayerId, defObj, actualAttacks, () => {
                card.usesLeft = defObj.usesLeft;
                if (defObj.usesLeft <= 0) {
                    player.defenseCard = null;
                }
                broadcastGameState();
            });
        } else {
            defObj.usesLeft -= 1;
            if (defObj.usesLeft <= 0) {
                player.defenseCard = null;
            }
            executeStandardAttack(socket.id, targetPlayerId, card.id);
        }
    });

    socket.on('discardDefense', () => {
        const currentTurnId = gameState.currentTurnPlayerId;
        if (socket.id !== currentTurnId || gameState.turnPhase !== 'MAIN') return;
        const player = gameState.players[socket.id];
        if (player.defenseCard) {
            player.defenseCard = null;
            broadcastGameState(`P${player.number} がセット中の防御カードを破棄しました。`);
        }
    });

    socket.on('endTurn', () => {
        resetScoreChanges();
        const currentTurnId = gameState.currentTurnPlayerId;
        if (socket.id !== currentTurnId) return;

        const player = gameState.players[socket.id];
        if (player.hand.length >= 2) {
            gameState.turnPhase = 'DISCARD';
            socket.emit('mustDiscard', { currentCount: player.hand.length });
            broadcastGameState(`P${player.number} は手札削減中...`);
        } else {
            proceedToNextTurn();
        }
    });

    socket.on('discardCard', (instanceId) => {
        const currentTurnId = gameState.currentTurnPlayerId;
        if (socket.id !== currentTurnId || gameState.turnPhase !== 'DISCARD') return;

        const player = gameState.players[socket.id];
        const cardIndex = player.hand.findIndex(c => String(c.instanceId) === String(instanceId));
        if (cardIndex !== -1) {
            const removed = player.hand.splice(cardIndex, 1)[0];
            if (player.hand.length <= 1) {
                gameState.turnPhase = 'MAIN';
                proceedToNextTurn();
            } else {
                socket.emit('mustDiscard', { currentCount: player.hand.length });
                broadcastGameState(`P${player.number} が「${removed.name}」を捨てました。`);
            }
        }
    });

    socket.on('disconnect', () => {
        delete gameState.players[socket.id];
        if (Object.keys(gameState.players).length === 0) {
            if (gameState.draft.timer) clearTimeout(gameState.draft.timer);
            gameState = createInitialState();
            console.log('全員切断のためリセット');
        } else {
            io.emit('playerUpdate', { playerCount: Object.keys(gameState.players).length });
        }
    });
});

function getWoodShieldHitRate(attackerScore, targetScore) {
    const diff = attackerScore - targetScore;
    const rate = Math.max(0, 1 - Math.abs(diff) / 10000);
    return rate;
}

function executeWoodShieldGroupAttack(attackerId, groupType) {
    const attacker = gameState.players[attackerId];
    if (!attacker) return;

    const myScore = attacker.score;
    const myOrderIndex = gameState.turnOrder.indexOf(attackerId);

    let candidates = Object.values(gameState.players).filter(p => {
        if (p.id === attackerId) return false;
        if (p.immunityCount && p.immunityCount > 0) return false;
        if (gameState.round === 1) {
            const pOrderIndex = gameState.turnOrder.indexOf(p.id);
            if (pOrderIndex > myOrderIndex) return false;
        }
        if (groupType === 'EQUAL_OR_HIGHER') {
            return p.score >= myScore;
        } else if (groupType === 'LOWER') {
            return p.score < myScore;
        }
        return false;
    });

    if (candidates.length === 0) {
        broadcastGameState(`P${attacker.number} が「木の盾」で攻撃を開始しましたが、対象となるプレイヤーがいませんでした。`);
        return;
    }

    const grouped = {};
    candidates.forEach(p => {
        const diff = Math.abs(myScore - p.score);
        if (!grouped[diff]) grouped[diff] = [];
        grouped[diff].push(p);
    });

    const sortedDiffs = Object.keys(grouped).map(Number).sort((a, b) => a - b);
    const attackQueue = [];

    sortedDiffs.forEach(diff => {
        const group = grouped[diff];
        for (let i = group.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [group[i], group[j]] = [group[j], group[i]];
        }
        attackQueue.push(...group);
    });

    function processQueue(index) {
        if (index >= attackQueue.length) {
            broadcastGameState(`P${attacker.number} の「木の盾」攻撃は誰にも命中・無効化されず終了しました。`);
            return;
        }

        const target = gameState.players[attackQueue[index].id];
        if (!target) {
            processQueue(index + 1);
            return;
        }

        const hitRate = getWoodShieldHitRate(attacker.score, target.score);

        // --- 修正箇所: 命中率0%の場合は処理およびログ出力をスキップ ---
        if (hitRate <= 0) {
            processQueue(index + 1);
            return;
        }

        const ratePercent = Math.round(hitRate * 100);
        let logPrefix = `P${attacker.number} の「木の盾」攻撃 (対象: P${target.number})！ `;

        const isHit = Math.random() < hitRate;

        if (!isHit) {
            broadcastGameState(logPrefix + `(命中率:${ratePercent}%) 攻撃は外れた！（ミス）`);
            setTimeout(() => processQueue(index + 1), 500);
            return;
        }

        // 無敵状態による無効化時：連鎖を中断して即座に終了
        if (target.invincibleTurns && target.invincibleTurns > 0) {
            broadcastGameState(logPrefix + `(命中率:${ratePercent}%) 命中！しかし P${target.number} は「無敵状態」のため攻撃が無効化されました！（攻撃中断）`);
            return;
        }

        if (target.defenseCard) {
            const isWoodSwordDefense = target.defenseCard.card.id === 'wood_sword';
            const isAttackerHigherScore = attacker.score > target.score;

            if (isWoodSwordDefense && isAttackerHigherScore) {
                broadcastGameState(logPrefix + `(命中率:${ratePercent}%) 命中！相手は「木の剣」をセット中ですが、自分より得点が高いプレイヤーからの攻撃のため防御効果が発動しません！`);
            } else {
                target.defenseCard.usesLeft -= 1;
                let msg = logPrefix + `(命中率:${ratePercent}%) 命中！しかし相手の防御カード「${target.defenseCard.card.name}」で無効化されました！（攻撃中断）`;
                if (target.defenseCard.usesLeft <= 0) {
                    target.defenseCard = null;
                    msg += '（相手の防御カード破棄）';
                }
                broadcastGameState(msg);
                return;
            }
        }

        applyScoreChange(target, -3000);
        target.immunityCount = 2;
        broadcastGameState(logPrefix + `(命中率:${ratePercent}%) 命中ヒット！ 得点-3000点！ (P${target.number}は選択不可状態になりました。攻撃中断)`);
    }

    processQueue(0);
}

function executeShieldSetGroupAttack(attackerId, groupType, cardObj, maxAttacks, onComplete) {
    const attacker = gameState.players[attackerId];
    if (!attacker) {
        onComplete();
        return;
    }

    const myScore = attacker.score;
    const myOrderIndex = gameState.turnOrder.indexOf(attackerId);

    // 攻撃対象の抽出
    function getCandidates() {
        return Object.values(gameState.players).filter(p => {
            if (p.id === attackerId) return false;
            if (p.immunityCount && p.immunityCount > 0) return false;
            if (gameState.round === 1) {
                const pOrderIndex = gameState.turnOrder.indexOf(p.id);
                if (pOrderIndex > myOrderIndex) return false;
            }
            if (groupType === 'EQUAL_OR_HIGHER') {
                return p.score >= myScore;
            } else if (groupType === 'LOWER') {
                return p.score < myScore;
            }
            return false;
        });
    }

    let attackCountUsed = 0;

    // グループ攻撃の1回分を開始する関数
    function startSingleGroupAttack() {
        const candidates = getCandidates();

        // 攻撃可能対象がいない、指定回数上限に達した、またはカードの耐久が尽きた場合は終了
        if (candidates.length === 0 || attackCountUsed >= maxAttacks || cardObj.usesLeft <= 0) {
            onComplete();
            return;
        }

        // 点差（絶対値）順に並び替え（同点差内はシャッフル）
        const grouped = {};
        candidates.forEach(p => {
            const diff = Math.abs(myScore - p.score);
            if (!grouped[diff]) grouped[diff] = [];
            grouped[diff].push(p);
        });

        const sortedDiffs = Object.keys(grouped).map(Number).sort((a, b) => a - b);
        const attackQueue = [];

        sortedDiffs.forEach(diff => {
            const group = grouped[diff];
            for (let i = group.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [group[i], group[j]] = [group[j], group[i]];
            }
            attackQueue.push(...group);
        });

        // 判定キューを順に処理
        function processQueue(index) {
            // 全員に外れた場合（キューを最後まで消化）
            if (index >= attackQueue.length) {
                // 全ミスでも1回分の攻撃指定回数およびカード耐久を1消費
                attackCountUsed++;
                cardObj.usesLeft -= 1;

                broadcastGameState(`P${attacker.number} の「木の盾セット」グループ攻撃は全員に外れました。（消費回数: ${attackCountUsed}/${maxAttacks}）`);

                // 残り回数と対象が存在すれば、点差が一番近い順から再攻撃（連鎖処理）
                setTimeout(() => {
                    startSingleGroupAttack();
                }, 500);
                return;
            }

            const target = gameState.players[attackQueue[index].id];
            if (!target) {
                processQueue(index + 1);
                return;
            }

            const hitRate = getWoodShieldHitRate(attacker.score, target.score);

            if (hitRate <= 0) {
                processQueue(index + 1);
                return;
            }

            const ratePercent = Math.round(hitRate * 100);
            let logPrefix = `P${attacker.number} の「木の盾セット」攻撃 (${attackCountUsed + 1}/${maxAttacks}回目, 対象: P${target.number})！ `;

            const isHit = Math.random() < hitRate;

            if (!isHit) {
                broadcastGameState(logPrefix + `(命中率:${ratePercent}%) 攻撃は外れた！（ミス）`);
                setTimeout(() => processQueue(index + 1), 500);
                return;
            }

            // ヒット時の回数・カード耐久消費
            attackCountUsed++;
            cardObj.usesLeft -= 1;

            // 無敵状態による無効化時：1回分消費した上で処理を即座に終了
            if (target.invincibleTurns && target.invincibleTurns > 0) {
                broadcastGameState(logPrefix + `(命中率:${ratePercent}%) 命中！しかし P${target.number} は「無敵状態」のため攻撃が無効化されました！（攻撃中断）`);
                onComplete();
                return;
            }

            if (target.defenseCard) {
                const isWoodSwordDefense = target.defenseCard.card.id === 'wood_sword';
                const isAttackerHigherScore = attacker.score > target.score;

                if (isWoodSwordDefense && isAttackerHigherScore) {
                    broadcastGameState(logPrefix + `(命中率:${ratePercent}%) 命中！相手は「木の剣」をセット中ですが、自分より得点が高いプレイヤーからの攻撃のため防御効果が発動しません！`);
                } else {
                    target.defenseCard.usesLeft -= 1;
                    let msg = logPrefix + `(命中率:${ratePercent}%) 命中！しかし相手の防御カード「${target.defenseCard.card.name}」で無効化されました！`;
                    if (target.defenseCard.usesLeft <= 0) {
                        target.defenseCard = null;
                        msg += '（相手の防御カード破棄）';
                    }
                    broadcastGameState(msg);
                    setTimeout(() => startSingleGroupAttack(), 500);
                    return;
                }
            }

            applyScoreChange(target, -3000);
            target.immunityCount = 2;
            broadcastGameState(logPrefix + `(命中率:${ratePercent}%) 命中ヒット！ 得点-3000点！ (P${target.number}は選択不可状態になりました)`);

            // ヒット後、残りの攻撃回数があれば次の回数分の攻撃へ
            setTimeout(() => startSingleGroupAttack(), 500);
        }

        processQueue(0);
    }

    startSingleGroupAttack();
}

function executeStandardAttack(attackerId, targetId, cardId) {
    const attacker = gameState.players[attackerId];
    const target = gameState.players[targetId];
    const cardName = cardId === 'wood_sword' ? '木の剣' : '木の盾';
    let logPrefix = `P${attacker.number} が P${target.number} に「${cardName}」で攻撃！ `;

    let hitRate = 0.5;
    if (cardId === 'wood_shield') {
        hitRate = getWoodShieldHitRate(attacker.score, target.score);
    }

    // --- 修正箇所: 命中率0%の場合は処理およびログ出力をスキップ ---
    if (hitRate <= 0) {
        return;
    }

    let isHit = Math.random() < hitRate;
    let ratePercent = Math.round(hitRate * 100);
    let rateText = `(命中率:${ratePercent}%) `;

    if (!isHit) {
        broadcastGameState(logPrefix + rateText + `攻撃は外れた！（ミス）`);
        return;
    }

    if (target.invincibleTurns && target.invincibleTurns > 0) {
        broadcastGameState(logPrefix + rateText + `命中！しかし P${target.number} は「無敵状態」のため攻撃が無効化されました！`);
        return;
    }

    if (target.defenseCard) {
        const isWoodSwordDefense = target.defenseCard.card.id === 'wood_sword';
        const isAttackerHigherScore = attacker.score > target.score;

        if (isWoodSwordDefense && isAttackerHigherScore) {
            broadcastGameState(logPrefix + rateText + `命中！相手は「木の剣」をセット中ですが、自分より得点が高いプレイヤーからの攻撃のため防御効果が発動しません！`);
        } else {
            target.defenseCard.usesLeft -= 1;
            let msg = logPrefix + rateText + `命中！しかし相手の防御カード「${target.defenseCard.card.name}」で無効化されました！`;
            if (target.defenseCard.usesLeft <= 0) {
                target.defenseCard = null;
                msg += '（相手の防御カード破棄）';
            }
            broadcastGameState(msg);
            return;
        }
    }

    applyScoreChange(target, -3000);
    target.immunityCount = 2;
    broadcastGameState(logPrefix + rateText + `命中ヒット！ 得点-3000点！ (P${target.number}は選択不可状態になりました)`);
}

function executeWoodSwordAttack(attackerId, targetTypeOrId) {
    const attacker = gameState.players[attackerId];

    if (targetTypeOrId === 'ALL_LOWER') {
        const attackedPlayerIds = new Set();

        function processNextLowerTarget() {
            const currentPlayers = Object.values(gameState.players);
            const currentAttackerScore = gameState.players[attackerId].score;

            const lowerPlayers = currentPlayers.filter(p =>
                p.score < currentAttackerScore &&
                !attackedPlayerIds.has(p.id) &&
                (!p.immunityCount || p.immunityCount <= 0)
            );
            if (lowerPlayers.length === 0) {
                if (attackedPlayerIds.size === 0) {
                    broadcastGameState(`P${attacker.number} が「木の剣」を使用しましたが、自分より下の順位のプレイヤーがいませんでした。`);
                }
                return;
            }

            lowerPlayers.sort((a, b) => b.score - a.score);

            const topScore = lowerPlayers[0].score;
            const topGroup = lowerPlayers.filter(p => p.score === topScore);

            const target = topGroup[Math.floor(Math.random() * topGroup.length)];
            attackedPlayerIds.add(target.id);

            let logPrefix = `P${attacker.number} の「木の剣」攻撃 (対象: P${target.number})！ `;

            const isHit = Math.random() < 0.5;

            if (!isHit) {
                broadcastGameState(logPrefix + `攻撃は外れた！（ミス）`);
                setTimeout(processNextLowerTarget, 500);
                return;
            }

            if (target.invincibleTurns && target.invincibleTurns > 0) {
                broadcastGameState(logPrefix + `命中！しかし P${target.number} は「無敵状態」のため攻撃が無効化されました！`);
                return;
            }

            if (target.defenseCard) {
                const isWoodSwordDefense = target.defenseCard.card.id === 'wood_sword';
                const isAttackerHigherScore = attacker.score > target.score;

                if (isWoodSwordDefense && isAttackerHigherScore) {
                    broadcastGameState(logPrefix + `命中！相手は「木の剣」をセット中ですが、自分より得点が高いプレイヤーからの攻撃のため防御効果が発動しません！`);
                } else {
                    target.defenseCard.usesLeft -= 1;
                    let msg = logPrefix + `命中！しかし相手の防御カード「${target.defenseCard.card.name}」で無効化されました！`;
                    if (target.defenseCard.usesLeft <= 0) {
                        target.defenseCard = null;
                        msg += '（相手の防御カード破棄）';
                    }
                    broadcastGameState(msg);
                    return;
                }
            }

            applyScoreChange(target, -3000);
            target.immunityCount = 2;
            broadcastGameState(logPrefix + `命中ヒット！ 得点-3000点！ (P${target.number}は選択不可状態になりました。)`);
            return;
        }

        processNextLowerTarget();
        return;
    }

    const target = gameState.players[targetTypeOrId];
    if (!target) return;

    const scoreDiff = target.score - attacker.score;

    if (scoreDiff < 0 || scoreDiff > 5000) {
        const socket = io.sockets.sockets.get(attackerId);
        if (socket) {
            socket.emit('errorMessage', '自分との得点差が0点以上+5000点以下のプレイヤーのみ攻撃対象に指定できます。');
        }
        return;
    }

    let logPrefix = `P${attacker.number} が P${target.number} に「木の剣」で攻撃！ `;

    const isHit = Math.random() < 0.5;

    if (!isHit) {
        broadcastGameState(logPrefix + `(成功率:50%) 攻撃は外れた！（ミス）`);
        return;
    }

    if (target.invincibleTurns && target.invincibleTurns > 0) {
        broadcastGameState(logPrefix + `(成功率:50%) 命中！しかし P${target.number} は「無敵状態」のため攻撃が無効化されました！`);
        return;
    }

    if (target.defenseCard) {
        const isWoodSwordDefense = target.defenseCard.card.id === 'wood_sword';
        const isAttackerHigherScore = attacker.score > target.score;

        if (isWoodSwordDefense && isAttackerHigherScore) {
            broadcastGameState(logPrefix + `(成功率:50%) 命中！相手は「木の剣」をセット中ですが、自分より得点が高いプレイヤーからの攻撃のため防御効果が発動しません！`);
        } else {
            target.defenseCard.usesLeft -= 1;
            let msg = logPrefix + `(成功率:50%) 命中！しかし相手の防御カード「${target.defenseCard.card.name}」で無効化されました！`;
            if (target.defenseCard.usesLeft <= 0) {
                target.defenseCard = null;
                msg += '（相手の防御カード破棄）';
            }
            broadcastGameState(msg);
            return;
        }
    }

    applyScoreChange(target, -3000);
    target.immunityCount = 2;
    broadcastGameState(logPrefix + `(成功率:50%) 命中ヒット！ 得点-3000点！ (P${target.number}は選択不可状態になりました)`);
}

function executeShieldSetAttack(attackerId, targetId, cardObj, maxAttacks, onComplete) {
    const attacker = gameState.players[attackerId];
    const target = gameState.players[targetId];

    const hitRate = getWoodShieldHitRate(attacker.score, target.score);

    // --- 修正箇所: 命中率0%の場合は処理せず終了 ---
    if (hitRate <= 0) {
        onComplete();
        return;
    }

    const ratePercent = Math.round(hitRate * 100);

    let attackIndex = 0;

    function doNextAttack() {
        if (attackIndex >= maxAttacks || cardObj.usesLeft <= 0) {
            onComplete();
            return;
        }

        attackIndex++;
        let logPrefix = `P${attacker.number} が P${target.number} に「木の盾セット」で攻撃 (${attackIndex}/${maxAttacks}回目)！ `;

        const isHit = Math.random() < hitRate;

        if (!isHit) {
            broadcastGameState(logPrefix + `(命中率:${ratePercent}%) 攻撃は外れた！（ミス）`);
            setTimeout(doNextAttack, 500);
            return;
        }

        cardObj.usesLeft -= 1;

        if (target.invincibleTurns && target.invincibleTurns > 0) {
            broadcastGameState(logPrefix + `(命中率:${ratePercent}%) 命中！しかし P${target.number} は「無敵状態」のため攻撃が無効化されました！`);
            setTimeout(doNextAttack, 500);
            return;
        }

        if (target.defenseCard) {
            target.defenseCard.usesLeft -= 1;
            let msg = logPrefix + `(命中率:${ratePercent}%) 命中！しかし相手の防御カード「${target.defenseCard.card.name}」で無効化されました！`;
            if (target.defenseCard.usesLeft <= 0) {
                target.defenseCard = null;
                msg += '（相手の防御カード破棄）';
            }
            broadcastGameState(msg);
            setTimeout(doNextAttack, 500);
            return;
        }

        applyScoreChange(target, -3000);
        target.immunityCount = 2;
        broadcastGameState(logPrefix + `(命中率:${ratePercent}%) 命中ヒット！ 得点-3000点！ (P${target.number}が選択不可状態になったため攻撃中断)`);

        onComplete();
    }

    doNextAttack();
}

function executeDisasterAttack(casterSocketId) {
    const caster = gameState.players[casterSocketId];
    if (!caster) return;

    io.emit('showCutIn', {
        title: '大災害発動！',
        imagePath: '/images/disaster.png'
    });

    setTimeout(() => {
        const initialPlayers = Object.values(gameState.players).map(p => ({
            id: p.id,
            score: p.score
        }));

        const rankMap = {};
        initialPlayers.forEach(p => {
            const higherCount = initialPlayers.filter(other => other.score > p.score).length;
            rankMap[p.id] = higherCount + 1;
        });

        const damageByRank = {
            1: -6000,
            2: -4000,
            3: -2000,
            4: -1000
        };

        Object.values(gameState.players).forEach(player => {
            if (player.id === casterSocketId) return;

            const rank = rankMap[player.id];
            const damage = damageByRank[rank] || 0;

            const isInvincible = player.invincibleTurns && player.invincibleTurns > 0;
            const isImmune = player.immunityCount && player.immunityCount > 0;

            if (!isInvincible && !isImmune) {
                applyScoreChange(player, damage);
                player.immunityCount = 2;
            }

            if (!isInvincible) {
                player.hand = [];
                player.defenseCard = null;
            }
        });

        broadcastGameState(`P${caster.number} が「大災害」を発動！(無敵状態のプレイヤーはダメージ・カード破棄を無効化)`);

    }, 2000);
}

// --- ダークマターの使用時処理 ---
function executeDarkMatter(casterSocketId) {
    const player = gameState.players[casterSocketId];
    if (!player) return;

    // 1. 無敵状態の付与（次の自分のターン開始時まで）
    player.invincibleTurns = 1;
    player.invincibleSource = 'DARK_MATTER';

    // 2. 自身の得点加算 (+5000点)
    const prevMyScore = player.score;
    applyScoreChange(player, 5000);
    const newMyScore = player.score;

    const penalizedNames = [];
    const myOrderIndex = gameState.turnOrder.indexOf(casterSocketId);

    // 3. 相手へのペナルティ判定
    Object.values(gameState.players).forEach(opponent => {
        if (opponent.id === player.id) return;

        // 1巡目において、使用者より後に行動するプレイヤーは対象から除外
        if (gameState.round === 1) {
            const opponentOrderIndex = gameState.turnOrder.indexOf(opponent.id);
            if (opponentOrderIndex > myOrderIndex) return;
        }

        // 対象が「無敵状態」または「選択不可状態」の場合はスキップ
        const isInvincible = opponent.invincibleTurns && opponent.invincibleTurns > 0;
        const isImmune = opponent.immunityCount && opponent.immunityCount > 0;
        if (isInvincible || isImmune) return;

        // 条件A： カード使用前に自分と同点だった相手
        const isConditionA = (opponent.score === prevMyScore);
        // 条件B： カード使用後に自分に追いつかれた・逆転された相手
        const isConditionB = (opponent.score > prevMyScore && newMyScore >= opponent.score);

        if (isConditionA || isConditionB) {
            // ★個別で 1/2 (50%) の確率判定
            const isSuccess = Math.random() < 0.5;

            if (isSuccess) {
                // 成功時 (50%)： 手札＆防御カード破棄、-3000点、選択不可状態(2ターン)付与
                opponent.hand = [];
                opponent.defenseCard = null;
                applyScoreChange(opponent, -3000);
                opponent.immunityCount = 2;

                penalizedNames.push(`P${opponent.number}(成功)`);
            } else {
                // 失敗時 (50%)： ペナルティ不発
                penalizedNames.push(`P${opponent.number}(不発)`);
            }
        }
    });

    let logMsg = `P${player.number} が「ダークマター」を使用！ 無敵状態になり、+5000点獲得！`;
    if (penalizedNames.length > 0) {
        logMsg += ` 対象結果: ${penalizedNames.join(', ')}`;
    }

    broadcastGameState(logMsg);
}

// --- 無敵アーマーの解除時処理 ---
function handleInvincibleArmorExpire(player) {
    const prevScore = player.score;

    // 1. 自身の得点加算 (+1000点)
    applyScoreChange(player, 1000);
    const newScore = player.score;

    let logMsg = `P${player.number} の「無敵アーマー」が解除され、+1000点獲得！`;
    const penalizedNames = [];

    // 2. 条件判定とペナルティ処理
    Object.values(gameState.players).forEach(opponent => {
        if (opponent.id === player.id) return;

        // 「選択不可状態」の相手は対象外
        if (opponent.immunityCount && opponent.immunityCount > 0) return;

        // 解除前に「同点以下（<=）」で、加算により同点以上になったかを判定
        if (prevScore <= opponent.score && newScore >= opponent.score) {
            // ★個別で 1/2 (50%) の確率判定
            const isSuccess = Math.random() < 0.5;

            if (isSuccess) {
                // 成功時 (50%)： 手札＆防御カード破棄、-3000点、選択不可状態(2ターン)付与
                opponent.hand = [];
                opponent.defenseCard = null;
                applyScoreChange(opponent, -3000);
                opponent.immunityCount = 2;

                penalizedNames.push(`P${opponent.number}(成功)`);
            } else {
                // 失敗時 (50%)： ペナルティ不発
                penalizedNames.push(`P${opponent.number}(不発)`);
            }
        }
    });

    if (penalizedNames.length > 0) {
        logMsg += ` ペナルティ判定結果: ${penalizedNames.join(', ')}`;
    }

    broadcastGameState(logMsg);
}
function skipDraftAndStartGame() {
    gameState.draft.phase = 'FINISHED';
    const scoreMap = { 1: 5000, 2: 1000, 3: -1000, 4: -5000 };
    Object.values(gameState.players).forEach(p => {
        p.score += (scoreMap[p.number] || 0);
        p.draftResolved = true;
    });
    finalizeDraftAndStartGame();
}

function resolveDraft() {
    if (gameState.draft.timer) clearTimeout(gameState.draft.timer);
    const choices = gameState.draft.choices;
    const scoreGroups = {};

    Object.keys(choices).forEach(id => {
        const score = choices[id];
        if (!scoreGroups[score]) scoreGroups[score] = [];
        scoreGroups[score].push(id);
    });

    Object.keys(scoreGroups).forEach(scoreStr => {
        const score = parseInt(scoreStr);
        const group = scoreGroups[scoreStr];
        const winnerId = group[Math.floor(Math.random() * group.length)];

        if (!gameState.players[winnerId].draftResolved) {
            gameState.players[winnerId].score += score;
            gameState.players[winnerId].draftResolved = true;
            const idx = gameState.draft.availableScores.indexOf(score);
            if (idx !== -1) gameState.draft.availableScores.splice(idx, 1);
        }
    });

    gameState.draft.choices = {};
    let unresolvedIds = Object.keys(gameState.players).filter(id => !gameState.players[id].draftResolved);

    if (unresolvedIds.length > 0 && gameState.draft.availableScores.length === 1) {
        const lastScore = gameState.draft.availableScores[0];
        unresolvedIds.forEach(id => {
            gameState.players[id].score += lastScore;
            gameState.players[id].draftResolved = true;
        });
        gameState.draft.availableScores = [];
        unresolvedIds = [];
    }

    if (unresolvedIds.length > 0) {
        io.emit('draftConflict', {
            players: gameState.players,
            availableScores: gameState.draft.availableScores,
            unresolvedIds: unresolvedIds
        });

        gameState.draft.timer = setTimeout(() => {
            autoFillDraftAndResolve();
        }, 15000);
    } else {
        gameState.draft.phase = 'FINISHED';
        finalizeDraftAndStartGame();
    }
}

function autoFillDraftAndResolve() {
    gameState.draft.timer = null;
    const unresolvedIds = Object.keys(gameState.players).filter(id => !gameState.players[id].draftResolved);
    unresolvedIds.forEach(id => {
        if (gameState.draft.choices[id] === undefined) {
            const randScore = gameState.draft.availableScores[Math.floor(Math.random() * gameState.draft.availableScores.length)];
            gameState.draft.choices[id] = randScore;
        }
    });
    resolveDraft();
}

function finalizeDraftAndStartGame() {
    gameState.started = true;
    gameState.actedPlayerIds = [];

    const sortedPlayers = Object.values(gameState.players).sort((a, b) => b.score - a.score);
    gameState.turnOrder = sortedPlayers.map(p => p.id);
    gameState.currentTurnPlayerId = sortedPlayers[0].id;

    startPlayerTurn();
}

function startPlayerTurn() {
    gameState.turnPhase = 'BONUS_CHOICE';
    const currentPlayer = gameState.players[gameState.currentTurnPlayerId];

    // 次の自分のターン開始時にダークマターの無敵状態を解除
    if (currentPlayer && currentPlayer.invincibleSource === 'DARK_MATTER') {
        currentPlayer.invincibleTurns = 0;
        currentPlayer.invincibleSource = null;
    }

    let logMsg = `第 ${gameState.round} 巡目: P${currentPlayer.number} のターンが始まりました。`;
    broadcastGameState(logMsg);
}

function proceedToNextTurn() {
    const endingPlayerId = gameState.currentTurnPlayerId;

    if (endingPlayerId && !gameState.actedPlayerIds.includes(endingPlayerId)) {
        gameState.actedPlayerIds.push(endingPlayerId);
    }

    // 無敵状態解除の対象者を格納する配列
    const expiredInvinciblePlayers = [];

    Object.values(gameState.players).forEach(p => {
        // 無敵アーマー(ARMOR)のみ毎ターン減算処理を行う
        if (p.invincibleTurns && p.invincibleTurns > 0 && p.invincibleSource === 'ARMOR') {
            p.invincibleTurns -= 1;
            if (p.invincibleTurns === 0) {
                expiredInvinciblePlayers.push(p);
            }
        }

        if (p.id !== endingPlayerId && p.immunityCount && p.immunityCount > 0) {
            p.immunityCount -= 1;
        }
    });

    // proceedToNextTurn 関数内の無敵解除処理部分
    expiredInvinciblePlayers.forEach(p => {
        if (p.invincibleSource === 'ARMOR') {
            handleInvincibleArmorExpire(p);
        }
        p.invincibleSource = null;
    });

    if (gameState.actedPlayerIds.length >= Object.keys(gameState.players).length) {
        gameState.actedPlayerIds = [];
        gameState.round++;

        if (gameState.round > 10) {
            const winner = Object.values(gameState.players).sort((a, b) => b.score - a.score)[0];
            io.emit('gameOver', { winner, players: gameState.players });
            return;
        }
    }

    const sortedPlayers = Object.values(gameState.players).sort((a, b) => b.score - a.score);
    gameState.turnOrder = sortedPlayers.map(p => p.id);

    const nextPlayer = sortedPlayers.find(p => !gameState.actedPlayerIds.includes(p.id));

    if (nextPlayer) {
        gameState.currentTurnPlayerId = nextPlayer.id;
    }

    startPlayerTurn();
}

function broadcastGameState(logMessage = '') {
    io.emit('syncGameState', {
        players: gameState.players,
        turnOrder: gameState.turnOrder,
        currentTurnPlayerId: gameState.currentTurnPlayerId,
        round: gameState.round,
        turnPhase: gameState.turnPhase,
        log: logMessage
    });
}

function resetScoreChanges() {
    Object.values(gameState.players).forEach(p => {
        p.scoreChange = 0;
        p.prevScore = p.score;
    });
}

function applyScoreChange(player, amount) {
    player.prevScore = player.score;
    player.scoreChange = amount;
    player.score += amount;
}

server.listen(3000, () => console.log('Server running on http://localhost:3000'));