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
        desc: '攻撃: 自分より上位なら単体(5000点差以内/成功率1/2)、下位なら全員順次判定(成功率1/2) / 防御: 攻撃を1度無効'
    },
    {
        id: 'gold_bag',
        name: '金袋',
        category: 'SCORE',
        image: '/images/gold_bag.png',
        desc: '自分の得点+3000'
    }
];

let cardSettings = {
    gold_bag: true,
    wood_sword: true,
    wood_shield: true,
    wood_shield_set: true
};

function createInitialState() {
    return {
        started: false,
        players: {},
        turnOrder: [],
        currentTurnIndex: 0,
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
        // 木の盾セットを手札または防御カードとして所持しているか確認
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
            immunityCount: 0
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
        const currentTurnId = gameState.turnOrder[gameState.currentTurnIndex];
        if (socket.id !== currentTurnId || gameState.turnPhase !== 'BONUS_CHOICE') return;

        const player = gameState.players[socket.id];
        if (acceptBonus) applyScoreChange(player, 3000);

        const randomCard = getRandomAvailableCard(player);
        player.hand.push(randomCard);

        gameState.turnPhase = 'MAIN';

        socket.broadcast.emit('syncGameState', {
            players: gameState.players,
            turnOrder: gameState.turnOrder,
            currentTurnPlayerId: gameState.turnOrder[gameState.currentTurnIndex],
            round: gameState.round,
            turnPhase: gameState.turnPhase,
            log: `P${player.number} がカードを1枚獲得し、メインフェーズに入りました。`
        });

        socket.emit('syncGameState', {
            players: gameState.players,
            turnOrder: gameState.turnOrder,
            currentTurnPlayerId: gameState.turnOrder[gameState.currentTurnIndex],
            round: gameState.round,
            turnPhase: gameState.turnPhase,
            log: `「${randomCard.name}」を獲得しました。`
        });
    });

    socket.on('playCard', ({ instanceId, actionTarget, targetPlayerId, attackCount }) => {
        resetScoreChanges();

        const currentTurnId = gameState.turnOrder[gameState.currentTurnIndex];
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

        // ★ 追加: 防御カードセット時の手札使用制限チェック
        // card.allowWithDefense が true のカードは例外として使用可能
        if (player.defenseCard && !card.allowWithDefense) {
            socket.emit('errorMessage', '防御カードがセットされています。');
            return;
        }

        // 1. 金袋の使用
        if (card.id === 'gold_bag') {
            applyScoreChange(player, 3000);
            player.hand.splice(cardIndex, 1);
            broadcastGameState(`P${player.number} が「金袋」を使用し、+3000点獲得しました！`);

            // 2. 攻撃アクション
        } else if (actionTarget === 'ATTACK') {
            if (!targetPlayerId) {
                socket.emit('errorMessage', '攻撃対象を選択してください。');
                return;
            }

            // 木の剣かつ全体攻撃(ALL_LOWER)の場合は単体対象の存在・選択不可チェックをスキップ
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

            // 3. 防御カードのセット
        } else if (actionTarget === 'DEFENSE') {
            if (player.defenseCard) {
                socket.emit('errorMessage', '防御カードはすでにセットされています。');
                return;
            }

            // 木の盾セットの場合は手札側で保持されている usesLeft を引き継ぎ（未定義なら初期値3）
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

    // セット中の防御カードを攻撃として使用
    socket.on('playDefenseAsAttack', ({ targetPlayerId, attackCount }) => {
        resetScoreChanges();
        const currentTurnId = gameState.turnOrder[gameState.currentTurnIndex];
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
                // カードデータ本体側にも残り回数を同期
                card.usesLeft = defObj.usesLeft;

                // 使用回数が0になったら防御カードから削除
                if (defObj.usesLeft <= 0) {
                    player.defenseCard = null;
                }

                // 攻撃および破棄完了後に最新のゲーム状態（更新された防御カード状態）を全員に同期・送信
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
        const currentTurnId = gameState.turnOrder[gameState.currentTurnIndex];
        if (socket.id !== currentTurnId || gameState.turnPhase !== 'MAIN') return;
        const player = gameState.players[socket.id];
        if (player.defenseCard) {
            player.defenseCard = null;
            broadcastGameState(`P${player.number} がセット中の防御カードを破棄しました。`);
        }
    });

    socket.on('endTurn', () => {
        resetScoreChanges();
        const currentTurnId = gameState.turnOrder[gameState.currentTurnIndex];
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
        const currentTurnId = gameState.turnOrder[gameState.currentTurnIndex];
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

// 木の剣の命中判定（順位差判定）
function checkSwordHitSuccess(attackerId, targetId) {
    const sorted = Object.values(gameState.players).sort((a, b) => b.score - a.score);
    const attackerRank = sorted.findIndex(p => p.id === attackerId) + 1;
    const targetRank = sorted.findIndex(p => p.id === targetId) + 1;
    const diff = Math.abs(attackerRank - targetRank);

    let successRate = 0.5; // ±1
    if (diff === 2) successRate = 0.2; // ±2: 1/5
    else if (diff >= 3) successRate = 0.1; // ±3: 1/10

    const isHit = Math.random() < successRate;
    return { isHit, diff, successRate };
}

// 通常カード（木の剣 / 木の盾）の攻撃実行
function executeStandardAttack(attackerId, targetId, cardId) {
    const attacker = gameState.players[attackerId];
    const target = gameState.players[targetId];
    const cardName = cardId === 'wood_sword' ? '木の剣' : '木の盾';
    let logPrefix = `P${attacker.number} が P${target.number} に「${cardName}」で攻撃！ `;

    // 1. 先に攻撃の命中判定を行う
    let isHit = false;
    let rateText = '';
    if (cardId === 'wood_sword') {
        const res = checkSwordHitSuccess(attackerId, targetId);
        isHit = res.isHit;
        rateText = `(順位差:${res.diff} / 成功率:${Math.round(res.successRate * 100)}%) `;
    } else {
        isHit = Math.random() < 0.5;
        rateText = `(成功率:50%) `;
    }

    // 2. 攻撃が失敗（ミス）した場合：防御カードは消費されずに攻撃失敗
    if (!isHit) {
        broadcastGameState(logPrefix + rateText + `攻撃は外れた！（ミス）`);
        return;
    }

    // 3. 攻撃が成功した場合：防御カードの有無を確認してガード判定
    if (target.defenseCard) {
        target.defenseCard.usesLeft -= 1;
        let msg = logPrefix + rateText + `命中！しかし相手の防御カード「${target.defenseCard.card.name}」で無効化されました！`;
        if (target.defenseCard.usesLeft <= 0) {
            target.defenseCard = null;
            msg += '（相手の防御カード破棄）';
        }
        broadcastGameState(msg);
        return;
    }

    // 4. 防御カードがない場合：そのままダメージ適用
    applyScoreChange(target, -3000);
    target.immunityCount = 2; // 選択不可状態
    broadcastGameState(logPrefix + rateText + `命中ヒット！ 得点-3000点！ (P${target.number}は選択不可状態になりました)`);
}

function executeWoodSwordAttack(attackerId, targetTypeOrId) {
    const attacker = gameState.players[attackerId];
    const sorted = Object.values(gameState.players).sort((a, b) => b.score - a.score);
    const attackerRank = sorted.findIndex(p => p.id === attackerId) + 1;

    // --- CASE 1: 自分より順位が下のプレイヤー全員への攻撃 ---
    if (targetTypeOrId === 'ALL_LOWER') {
        const lowerPlayers = sorted.slice(attackerRank); // 自分より順位が下のプレイヤー配列

        if (lowerPlayers.length === 0) {
            broadcastGameState(`P${attacker.number} が「木の剣」を使用しましたが、自分より下の順位のプレイヤーがいませんでした。`);
            return;
        }

        let currentIdx = 0;

        function processNextLowerTarget() {
            if (currentIdx >= lowerPlayers.length) {
                // 全員命中・防御判定をスルーした場合もカード破棄（終了）
                return;
            }

            const target = lowerPlayers[currentIdx];
            let logPrefix = `P${attacker.number} の「木の剣」攻撃 (対象: P${target.number})！ `;

            // 1. 命中判定（1/2）
            const isHit = Math.random() < 0.5;

            if (!isHit) {
                // ミスの場合、攻撃は中断されず次のプレイヤーへ
                broadcastGameState(logPrefix + `攻撃は外れた！（ミス）`);
                currentIdx++;
                setTimeout(processNextLowerTarget, 500);
                return;
            }

            // 2. 命中した場合、防御カードチェック
            if (target.defenseCard) {
                target.defenseCard.usesLeft -= 1;
                let msg = logPrefix + `命中！しかし相手の防御カード「${target.defenseCard.card.name}」で無効化されました！`;
                if (target.defenseCard.usesLeft <= 0) {
                    target.defenseCard = null;
                    msg += '（相手の防御カード破棄）';
                }
                broadcastGameState(msg);
                return; // 防御発生のため攻撃中断
            }

            // 3. 防御なし：ダメージ適用および選択不可状態付与
            applyScoreChange(target, -3000);
            target.immunityCount = 2; // 自分以外の対戦相手3人×2ターン経過で解除
            broadcastGameState(logPrefix + `命中ヒット！ 得点-3000点！ (P${target.number}は選択不可状態になりました)`);
            return; // ダメージ発生のため攻撃中断
        }

        processNextLowerTarget();
        return;
    }

    // --- CASE 2: 自分より順位が上のプレイヤー単体への攻撃 ---
    const target = gameState.players[targetTypeOrId];
    if (!target) return;

    const targetRank = sorted.findIndex(p => p.id === target.id) + 1;

    // バリデーションチェック
    if (attackerRank <= targetRank) {
        socket.emit('errorMessage', '自分より下の順位のプレイヤーは個別に対象に指定できません。');
        return;
    }

    if ((target.score - attacker.score) > 5000) {
        socket.emit('errorMessage', '得点差が5000点を超えるプレイヤーは攻撃対象に選択できません。');
        return;
    }

    let logPrefix = `P${attacker.number} が P${target.number} に「木の剣」で攻撃！ `;

    // 命中判定（1/2）
    const isHit = Math.random() < 0.5;

    if (!isHit) {
        broadcastGameState(logPrefix + `(成功率:50%) 攻撃は外れた！（ミス）`);
        return;
    }

    if (target.defenseCard) {
        target.defenseCard.usesLeft -= 1;
        let msg = logPrefix + `(成功率:50%) 命中！しかし相手の防御カード「${target.defenseCard.card.name}」で無効化されました！`;
        if (target.defenseCard.usesLeft <= 0) {
            target.defenseCard = null;
            msg += '（相手の防御カード破棄）';
        }
        broadcastGameState(msg);
        return;
    }

    applyScoreChange(target, -3000);
    target.immunityCount = 2;
    broadcastGameState(logPrefix + `(成功率:50%) 命中ヒット！ 得点-3000点！ (P${target.number}は選択不可状態になりました)`);
}

// 木の盾セットのまとめ攻撃処理
function executeShieldSetAttack(attackerId, targetId, cardObj, maxAttacks, onComplete) {
    const attacker = gameState.players[attackerId];
    const target = gameState.players[targetId];

    let attackIndex = 0;

    function doNextAttack() {
        if (attackIndex >= maxAttacks || cardObj.usesLeft <= 0) {
            onComplete();
            return;
        }

        attackIndex++;
        cardObj.usesLeft -= 1;
        let logPrefix = `P${attacker.number} が P${target.number} に「木の盾セット」で攻撃 (${attackIndex}/${maxAttacks}回目)！ `;

        // 1. 先に成功率（50%）の判定を行う
        const isHit = Math.random() < 0.5;

        // 2. 失敗（ミス）した場合：防御カードは消費せず、次の攻撃へ
        if (!isHit) {
            broadcastGameState(logPrefix + `(成功率:50%) 攻撃は外れた！（ミス）`);
            setTimeout(doNextAttack, 500);
            return;
        }

        // 3. 成功した場合：防御カードの有無を確認してガード判定
        if (target.defenseCard) {
            target.defenseCard.usesLeft -= 1;
            let msg = logPrefix + `(成功率:50%) 命中！しかし相手の防御カード「${target.defenseCard.card.name}」で無効化されました！`;
            if (target.defenseCard.usesLeft <= 0) {
                target.defenseCard = null;
                msg += '（相手の防御カード破棄）';
            }
            broadcastGameState(msg);
            // 防御成功時も攻撃回数を消費して次の攻撃へ
            setTimeout(doNextAttack, 500);
            return;
        }

        // 4. 防御カードがない場合：ダメージ適用して攻撃中断
        applyScoreChange(target, -3000);
        target.immunityCount = 2; // 選択不可状態を付与
        broadcastGameState(logPrefix + `(成功率:50%) 命中ヒット！ 得点-3000点！ (P${target.number}が選択不可状態になったため攻撃中断)`);
        
        onComplete();
    }

    doNextAttack();
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
    const sortedPlayers = Object.values(gameState.players).sort((a, b) => b.score - a.score);
    gameState.turnOrder = sortedPlayers.map(p => p.id);
    gameState.currentTurnIndex = 0;
    startPlayerTurn();
}

function startPlayerTurn() {
    gameState.turnPhase = 'BONUS_CHOICE';
    const currentTurnId = gameState.turnOrder[gameState.currentTurnIndex];
    const currentPlayer = gameState.players[currentTurnId];

    let logMsg = `第 ${gameState.round} 巡目: P${currentPlayer.number} のターンが始まりました。`;
    broadcastGameState(logMsg);
}

function proceedToNextTurn() {
    const endingPlayerId = gameState.turnOrder[gameState.currentTurnIndex];

    // ターンを終えたプレイヤー以外の「選択不可状態」のカウントを減らす
    Object.values(gameState.players).forEach(p => {
        if (p.id !== endingPlayerId && p.immunityCount && p.immunityCount > 0) {
            p.immunityCount -= 1;
        }
    });

    gameState.currentTurnIndex++;
    if (gameState.currentTurnIndex >= gameState.turnOrder.length) {
        gameState.currentTurnIndex = 0;
        gameState.round++;

        const sortedPlayers = Object.values(gameState.players).sort((a, b) => b.score - a.score);
        gameState.turnOrder = sortedPlayers.map(p => p.id);
    }

    if (gameState.round > 10) {
        const winner = Object.values(gameState.players).sort((a, b) => b.score - a.score)[0];
        io.emit('gameOver', { winner, players: gameState.players });
        return;
    }

    startPlayerTurn();
}

function broadcastGameState(logMessage = '') {
    const currentTurnId = gameState.turnOrder[gameState.currentTurnIndex];
    io.emit('syncGameState', {
        players: gameState.players,
        turnOrder: gameState.turnOrder,
        currentTurnPlayerId: currentTurnId,
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
    resetScoreChanges();
    player.prevScore = player.score;
    player.scoreChange = amount;
    player.score += amount;
}

server.listen(3000, () => console.log('Server running on http://localhost:3000'));