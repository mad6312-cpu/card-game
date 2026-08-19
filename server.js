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
        desc: '攻撃: 成功率1/2で-3000(命中時相手は選択不可) / 防御: 攻撃を1度無効'
    },
    {
        id: 'wood_shield_set',
        name: '木の盾セット',
        category: 'DEFENSE',
        image: '/images/wood_shield_set.png',
        desc: '攻撃: 成功率1/2で-3000(最大3回まとめて攻撃) / 防御: 攻撃を無効(計3回使用で破棄)'
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
        image: '/images/invincible_armor.png', // ※適切な画像パスを指定してください
        desc: '特殊カード: 使用から合計4ターン経過まで「無敵状態」になる。防御カードセット時も使用可。無敵解除時に破棄。',
        allowWithDefense: true
    }
];

let cardSettings = {
    gold_bag: true,
    wood_sword: true,
    wood_shield: true,
    wood_shield_set: true,
    disaster: true,
    invincible_armor: true
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
            invincibleTurns: 0 // ★追加：無敵状態の残りターン数
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
            if (player.invincibleTurns > 0) {
                socket.emit('errorMessage', 'すでに「無敵状態」のため使用できません。');
                return;
            }
            player.invincibleTurns = 4;

            // 本人へのみログを通知
            socket.emit('syncGameState', {
                players: gameState.players,
                turnOrder: gameState.turnOrder,
                currentTurnPlayerId: gameState.currentTurnPlayerId,
                round: gameState.round,
                turnPhase: gameState.turnPhase,
                log: `「無敵アーマー」を使用しました。4ターンの間「無敵状態」になります。`
            });

            // 本人以外の他プレイヤーにはログを流さない（ゲーム状態の同期のみ行う）
            socket.broadcast.emit('syncGameState', {
                players: gameState.players,
                turnOrder: gameState.turnOrder,
                currentTurnPlayerId: gameState.currentTurnPlayerId,
                round: gameState.round,
                turnPhase: gameState.turnPhase,
                log: ''
            });
        } else if (actionTarget === 'ATTACK') {
            if (!targetPlayerId) {
                socket.emit('errorMessage', '攻撃対象を選択してください。');
                return;
            }

            if (card.id === 'wood_sword' && targetPlayerId === 'ALL_LOWER') {
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

        const defObj = player.defenseCard;
        const card = defObj.card;

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

function executeStandardAttack(attackerId, targetId, cardId) {
    const attacker = gameState.players[attackerId];
    const target = gameState.players[targetId];
    const cardName = cardId === 'wood_sword' ? '木の剣' : '木の盾';
    let logPrefix = `P${attacker.number} が P${target.number} に「${cardName}」で攻撃！ `;

    let hitRate = 0.5;
    if (cardId === 'wood_shield') {
        const diff = attacker.score - target.score;
        if (Math.abs(diff) >= 10000) {
            const socket = io.sockets.sockets.get(attackerId);
            if (socket) socket.emit('errorMessage', '得点差が±10000点以上のため「木の盾」で攻撃できません。');
            return;
        }
        hitRate = getWoodShieldHitRate(attacker.score, target.score);
    }

    let isHit = Math.random() < hitRate;
    let ratePercent = Math.round(hitRate * 100);
    let rateText = `(命中率:${ratePercent}%) `;

    if (!isHit) {
        broadcastGameState(logPrefix + rateText + `攻撃は外れた！（ミス）`);
        return;
    }

    // ★追加：対象が「無敵状態」の場合の無効化処理（カード破棄なし）
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

            // ★追加：対象が「無敵状態」の場合の無効化処理
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

    // ★追加：対象が「無敵状態」の場合の無効化処理
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

    const diff = attacker.score - target.score;
    if (Math.abs(diff) >= 10000) {
        const socket = io.sockets.sockets.get(attackerId);
        if (socket) socket.emit('errorMessage', '得点差が±10000点以上のため「木の盾セット」で攻撃できません。');
        return;
    }

    const hitRate = getWoodShieldHitRate(attacker.score, target.score);
    const ratePercent = Math.round(hitRate * 100);

    let attackIndex = 0;

    function doNextAttack() {
        if (attackIndex >= maxAttacks || cardObj.usesLeft <= 0) {
            onComplete();
            return;
        }

        attackIndex++;
        cardObj.usesLeft -= 1;
        let logPrefix = `P${attacker.number} が P${target.number} に「木の盾セット」で攻撃 (${attackIndex}/${maxAttacks}回目)！ `;

        const isHit = Math.random() < hitRate;

        if (!isHit) {
            broadcastGameState(logPrefix + `(命中率:${ratePercent}%) 攻撃は外れた！（ミス）`);
            setTimeout(doNextAttack, 500);
            return;
        }

        // ★追加：対象が「無敵状態」の場合の無効化処理
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

            // ★追加：「無敵状態」でなく、かつ選択不可状態でもない場合のみダメージ適用
            const isInvincible = player.invincibleTurns && player.invincibleTurns > 0;
            const isImmune = player.immunityCount && player.immunityCount > 0;

            if (!isInvincible && !isImmune) {
                applyScoreChange(player, damage);
                player.immunityCount = 2;
            }

            // 無敵状態であっても「大災害」を受けた場合は手札・防御カードが破棄される
            player.hand = player.hand.filter(c => c.id === 'invincible_armor'); // 無敵アーマー自体は破棄されない
            player.defenseCard = null;
        });

        broadcastGameState(`P${caster.number} が「大災害」を発動！(無敵状態・選択不可状態のプレイヤーはダメージ無効化)`);

    }, 2000);
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

    let logMsg = `第 ${gameState.round} 巡目: P${currentPlayer.number} のターンが始まりました。`;
    broadcastGameState(logMsg);
}

function proceedToNextTurn() {
    const endingPlayerId = gameState.currentTurnPlayerId;

    if (endingPlayerId && !gameState.actedPlayerIds.includes(endingPlayerId)) {
        gameState.actedPlayerIds.push(endingPlayerId);
    }

    // ★追加：全プレイヤーの「無敵状態」および「選択不可状態」のターンカウント減少
    Object.values(gameState.players).forEach(p => {
        // 無敵状態カウント減算
        if (p.invincibleTurns && p.invincibleTurns > 0) {
            p.invincibleTurns -= 1;
            if (p.invincibleTurns === 0) {
                // 無敵状態解除時に無敵アーマーカードを破棄[cite: 14]
                p.hand = p.hand.filter(c => c.id !== 'invincible_armor');
            }
        }

        // 選択不可状態カウント減算[cite: 14]
        if (p.id !== endingPlayerId && p.immunityCount && p.immunityCount > 0) {
            p.immunityCount -= 1;
        }
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