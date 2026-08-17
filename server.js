const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const CARD_DECK = [
    { id: 'wood_shield', name: '木の盾', category: 'DEFENSE_TRAP', desc: '防御: 攻撃を1回無効 / 罠: 左中右一致で相手に-3000' },
    { id: 'wood_shield_set', name: '木の盾セット', category: 'DEFENSE_TRAP', desc: '防御: 攻撃を3回無効 / 罠: 3回まで左中右一致で相手に-3000' },
    { id: 'wood_sword', name: '木の剣', category: 'DEFENSE_TRAP', desc: '攻撃: 相手に-3000(順位差で成功率変化) / 防御: 1回無効 / 罠: 左中右一致で相手に-3000(1巡で消滅)' },
    { id: 'gold_bag', name: '金袋', category: 'SCORE', desc: '自分の得点+3000' }
];

// デバッグ用カード有効化フラグ
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
        },
        trapBattle: null
    };
}

let gameState = createInitialState();

// 有効なカードからランダムに1枚抽出
function getRandomAvailableCard(player) {
    let availableCards = CARD_DECK.filter(c => cardSettings[c.id] !== false);

    if (player) {
        // 木の盾セットを既に「手札」「防御」「罠」のどこかに持っているかチェック
        const hasShieldSetInHand = player.hand && player.hand.some(c => c.id === 'wood_shield_set');
        const hasShieldSetInDefense = player.defenseCard && player.defenseCard.card && player.defenseCard.card.id === 'wood_shield_set';
        const hasShieldSetInTrap = player.trapSlots && Object.values(player.trapSlots).some(slot => slot && slot.card && slot.card.id === 'wood_shield_set');

        const hasWoodShieldSet = hasShieldSetInHand || hasShieldSetInDefense || hasShieldSetInTrap;

        // 既に持っている場合はドロー候補（pool）から「木の盾セット」を除外する
        if (hasWoodShieldSet) {
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
            hand: [],
            defenseCard: null,
            trapSlots: { 1: null, 2: null, 3: null },
            draftResolved: false
        };

        socket.emit('init', { playerNumber: pNum, id: socket.id });
        io.emit('playerUpdate', { playerCount: Object.keys(gameState.players).length });
        socket.emit('updateCardSettings', cardSettings);

        if (Object.keys(gameState.players).length === 4) {
            // デバッグ用: ドラフトフェーズをスキップして固定スコアを付与
            skipDraftAndStartGame();
        }
    } else {
        socket.emit('full');
    }

    // デバッグ用：カード設定変更の受信
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

        if (acceptBonus) player.score += 3000;

        // ON/OFF設定および重複所持チェックを適用してカードを付与
        const randomCard = getRandomAvailableCard(player);
        player.hand.push(randomCard);

        gameState.turnPhase = 'MAIN';
        // 1. 全員向けのログ（カード名を伏せる）
        broadcastGameState(`P${player.number} がカードを1枚獲得し、メインフェーズに入りました。`);

        // 2. 本人の画面（socket）に直接ゲーム状態メッセージを送る
        socket.emit('message', `【自分のみ】「${randomCard.name}」を獲得しました。`);
    });

    socket.on('playCard', ({ instanceId, actionTarget, targetPlayerId, trapSlotNum }) => {
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

        // 1. 金袋の使用
        if (card.id === 'gold_bag') {
            player.score += 3000;
            player.hand.splice(cardIndex, 1);
            broadcastGameState(`P${player.number} が「金袋」を使用し、+3000点獲得しました！`);

        // 2. 「攻撃アクション」の場合（木の剣などを攻撃として使う場合）
        } else if (actionTarget === 'ATTACK') {
            if (!targetPlayerId || !gameState.players[targetPlayerId] || targetPlayerId === socket.id) {
                socket.emit('errorMessage', '攻撃対象を選択してください。');
                return;
            }

            const target = gameState.players[targetPlayerId];

            // ★ 選択不可状態のチェック
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

            player.hand.splice(cardIndex, 1);
            const slot = Number(trapSlotNum) || 1;

            if (target.trapSlots && target.trapSlots[slot]) {
                startTrapBattle(socket.id, targetPlayerId, slot);
            } else {
                executeSwordAttack(socket.id, targetPlayerId, slot);
            }

        // 3. 「防御セット」または「罠セット」のアクションの場合
        } else if (card.category === 'DEFENSE_TRAP') {
            const uses = (card.id === 'wood_shield_set') ? 3 : 1;
            
            if (actionTarget === 'DEFENSE') {
                if (player.defenseCard) {
                    socket.emit('errorMessage', '防御カードはすでにセットされています。');
                    return;
                }
                player.defenseCard = { card, usesLeft: uses };
                player.hand.splice(cardIndex, 1);
                broadcastGameState(`P${player.number} が防御カード「${card.name}」をセットしました。`);

            } else if (actionTarget === 'TRAP') {
                if (player.defenseCard) {
                    socket.emit('errorMessage', '防御カードをセットしている間は、新たに罠カードをセットできません。');
                    return;
                }

                const slot = Number(trapSlotNum);
                if (![1, 2, 3].includes(slot)) {
                    socket.emit('errorMessage', '正しくスロットを選択してください。');
                    return;
                }
                if (player.trapSlots[slot]) {
                    socket.emit('errorMessage', `スロット${slot} には既に罠がセットされています。`);
                    return;
                }

                // placedRound: 設置時の巡数を記録
                player.trapSlots[slot] = { 
                    card, 
                    usesLeft: uses, 
                    placedRound: gameState.round 
                };
                player.hand.splice(cardIndex, 1);
                broadcastGameState(`P${player.number} がスロット ${slot} に罠カード「${card.name}」をセットしました。`);
            }
        }
    });

    socket.on('moveDefenseToTrap', ({ trapSlotNum }) => {
        const currentTurnId = gameState.turnOrder[gameState.currentTurnIndex];
        if (socket.id !== currentTurnId || gameState.turnPhase !== 'MAIN') return;

        const player = gameState.players[socket.id];
        if (!player.defenseCard) {
            socket.emit('errorMessage', 'セットされている防御カードがありません。');
            return;
        }

        const slot = Number(trapSlotNum);
        if (![1, 2, 3].includes(slot) || player.trapSlots[slot]) {
            socket.emit('errorMessage', '指定されたスロットに移し替えることができません。');
            return;
        }

        // 防御から移し替えた時点の巡数を記録
        player.trapSlots[slot] = {
            card: player.defenseCard.card,
            usesLeft: player.defenseCard.usesLeft,
            placedRound: gameState.round
        };
        const movedCardName = player.defenseCard.card.name;
        player.defenseCard = null;

        broadcastGameState(`P${player.number} が防御カード「${movedCardName}」をスロット ${slot} の罠に移し替えました！`);
    });

    socket.on('selectTrapChoice', (choice) => {
        if (!gameState.trapBattle) return;
        const { attackerId, targetId, choices } = gameState.trapBattle;
        if (socket.id !== attackerId && socket.id !== targetId) return;

        choices[socket.id] = choice;

        if (choices[attackerId] && choices[targetId]) {
            if (gameState.trapBattle.timer) clearTimeout(gameState.trapBattle.timer);
            resolveTrapBattle();
        } else {
            io.emit('trapBattleUpdate', {
                attackerChosen: !!choices[attackerId],
                targetChosen: !!choices[targetId]
            });
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
            if (gameState.trapBattle && gameState.trapBattle.timer) clearTimeout(gameState.trapBattle.timer);
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

    let successRate = 0.5; // デフォルト (±1)
    if (diff === 2) successRate = 0.2; // 1/5
    else if (diff >= 3) successRate = 0.1; // 1/10

    const isHit = Math.random() < successRate;
    return { isHit, diff, successRate };
}

// 木の剣の単体攻撃処理
function executeSwordAttack(attackerId, targetId, slotNum) {
    const attacker = gameState.players[attackerId];
    const target = gameState.players[targetId];
    let logPrefix = `P${attacker.number} が P${target.number} のスロット${slotNum} に「木の剣」で攻撃！ `;

    // 1. 防御カードの優先チェック（成功率判定の前）
    if (target.defenseCard) {
        target.defenseCard.usesLeft -= 1;
        let msg = logPrefix + `防御カードで確定無効化されました！`;
        if (target.defenseCard.usesLeft <= 0) {
            target.defenseCard = null;
            msg += '（防御カード破棄）';
        }
        broadcastGameState(msg);
        return; // 防御カードで無効化されたためここで終了
    }

    // 2. 防御カードがない場合のみ命中判定（確率判定）
    const { isHit, diff, successRate } = checkSwordHitSuccess(attackerId, targetId);
    const ratePercent = Math.round(successRate * 100);

    if (!isHit) {
        broadcastGameState(logPrefix + `(順位差:${diff} / 成功率:${ratePercent}%) 攻撃は外れた！（ミス）`);
    } else {
        target.score -= 3000;
        target.immunityCount = 2; // ★ 木の剣命中により「選択不可状態(カウント2)」を付与
        broadcastGameState(logPrefix + `(順位差:${diff} / 成功率:${ratePercent}%) 命中ヒット！ 得点-3000点！(P${target.number}は選択不可状態になりました)`);
    }
}

function startTrapBattle(attackerId, targetId, slotNum) {
    const attacker = gameState.players[attackerId];
    const target = gameState.players[targetId];
    const activeTrapObj = target.trapSlots[slotNum];

    // ★ 罠が発動したため、全プレイヤーに常時開示するフラグを付与
    if (activeTrapObj) {
        activeTrapObj.revealed = true;
    }

    gameState.turnPhase = 'TRAP_BATTLE';
    gameState.trapBattle = {
        attackerId,
        targetId,
        slotNum,
        trapName: activeTrapObj.card.name,
        choices: {},
        timer: null
    };

    io.emit('trapBattleStart', {
        attackerId,
        targetId,
        attackerName: attacker.name,
        targetName: target.name,
        trapName: activeTrapObj.card.name,
        slotNum
    });

    broadcastGameState(`【罠発動！】P${attacker.number} が P${target.number} のスロット${slotNum}を攻撃！ 罠「${activeTrapObj.card.name}」が作動！ 10秒以内に選択してください！`);

    gameState.trapBattle.timer = setTimeout(() => {
        resolveTrapBattle();
    }, 10000);
}

function resolveTrapBattle() {
    if (!gameState.trapBattle) return;
    if (gameState.trapBattle.timer) clearTimeout(gameState.trapBattle.timer);

    const { attackerId, targetId, slotNum, choices } = gameState.trapBattle;
    const attacker = gameState.players[attackerId];
    const target = gameState.players[targetId];
    const options = ['LEFT', 'CENTER', 'RIGHT'];

    const attackerChoice = choices[attackerId] || options[Math.floor(Math.random() * options.length)];
    const targetChoice = choices[targetId] || options[Math.floor(Math.random() * options.length)];
    const optionsText = { 'LEFT': '左', 'CENTER': '中', 'RIGHT': '右' };

    let logMsg = `【罠結果】 攻撃(P${attacker.number}):[${optionsText[attackerChoice]}] VS 防御(P${target.number}):[${optionsText[targetChoice]}] → `;

    const activeTrapObj = target.trapSlots[slotNum];

    if (attackerChoice === targetChoice) {
        attacker.score -= 3000;
        logMsg += `一致！ スロット${slotNum}の罠「${activeTrapObj.card.name}」成功！ 攻撃失敗＆P${attacker.number}に-3000点！`;

        activeTrapObj.usesLeft -= 1;
        if (activeTrapObj.usesLeft <= 0) {
            target.trapSlots[slotNum] = null;
            logMsg += `（罠カード解除）`;
        }
    } else {
        logMsg += `不一致！ 罠回避... `;

        activeTrapObj.usesLeft -= 1;
        if (activeTrapObj.usesLeft <= 0) {
            target.trapSlots[slotNum] = null;
            logMsg += `（罠カード解除） `;
        }

        // 1. 罠回避後、防御カードの優先チェック
        if (target.defenseCard) {
            target.defenseCard.usesLeft -= 1;
            logMsg += `防御カードで確定無効化されました！`;
            if (target.defenseCard.usesLeft <= 0) {
                target.defenseCard = null;
                logMsg += '（防御カード破棄）';
            }
        } else {
            // 2. 防御カードがない場合のみ確率判定
            const { isHit, diff, successRate } = checkSwordHitSuccess(attackerId, targetId);
            const ratePercent = Math.round(successRate * 100);

            if (!isHit) {
                logMsg += `(順位差:${diff} / 成功率:${ratePercent}%) 攻撃は外れた！（ミス）`;
            } else {
                target.score -= 3000;
                target.immunityCount = 2; // ★ 罠回避後の命中時も付与
                logMsg += `(順位差:${diff} / 成功率:${ratePercent}%) 命中！ P${target.number} は -3000点！(選択不可状態)`;
            }
        }
    }

    gameState.trapBattle = null;
    gameState.turnPhase = 'MAIN';

    io.emit('trapBattleEnd', {
        attackerChoice: optionsText[attackerChoice],
        targetChoice: optionsText[targetChoice],
        matched: attackerChoice === targetChoice
    });

    broadcastGameState(logMsg);
}

function startDraftPhase() {
    gameState.draft.phase = 'SELECTING';
    gameState.draft.choices = {};
    io.emit('draftStart', { availableScores: gameState.draft.availableScores });

    if (gameState.draft.timer) clearTimeout(gameState.draft.timer);
    gameState.draft.timer = setTimeout(() => {
        autoFillDraftAndResolve();
    }, 30000);
}

// デバッグ用：ドラフトフェーズをスキップしてゲームを開始する処理
function skipDraftAndStartGame() {
    gameState.draft.phase = 'FINISHED';
    
    // P1〜P4に固定得点を付与
    const scoreMap = { 1: 5000, 2: 1000, 3: -1000, 4: -5000 };
    Object.values(gameState.players).forEach(p => {
        p.score += (scoreMap[p.number] || 0);
        p.draftResolved = true;
    });

    finalizeDraftAndStartGame();
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

    // 罠カードの自動消滅判定
    let expiredLogs = [];
    [1, 2, 3].forEach(slotNum => {
        const trapObj = currentPlayer.trapSlots[slotNum];
        if (trapObj && trapObj.placedRound !== undefined) {
            // 木の剣は1巡、その他（木の盾など）は3巡で消滅
            const expireLimit = (trapObj.card.id === 'wood_sword') ? 1 : 3;
            if (gameState.round - trapObj.placedRound >= expireLimit) {
                expiredLogs.push(`スロット${slotNum}の「${trapObj.card.name}」`);
                currentPlayer.trapSlots[slotNum] = null; // 罠消滅
            }
        }
    });

    let logMsg = `第 ${gameState.round} 巡目: P${currentPlayer.number} のターンが始まりました。`;
    if (expiredLogs.length > 0) {
        logMsg += `【時間切れ消滅】 設置から3巡が経過したため、P${currentPlayer.number} の${expiredLogs.join('・')}が消滅しました。`;
    }

    broadcastGameState(logMsg);
}

function proceedToNextTurn() {
    const endingPlayerId = gameState.turnOrder[gameState.currentTurnIndex];

    // ★ ターンを終えたプレイヤー「以外」で、選択不可状態のプレイヤーのカウントを1下げる
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

server.listen(3000, () => console.log('Server running on http://localhost:3000'));