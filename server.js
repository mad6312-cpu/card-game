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
        image: '/images/disaster.png', // ※適切な画像パスを指定してください
        desc: '使用者以外全員対象(命中100%)。手札/防御カード全破棄。1位:-6000/2位:-4000/3位:-2000/4位:-1000。ダメージ対象は選択不可(1巡分)付与。'
    }
];

let cardSettings = {
    gold_bag: true,
    wood_sword: true,
    wood_shield: true,
    wood_shield_set: true,
    disaster: true
};

function createInitialState() {
    return {
        started: false,
        players: {},
        turnOrder: [],
        currentTurnPlayerId: null, // currentTurnIndex から ID直接保持へ変更
        actedPlayerIds: [],        // その巡で既に行動したプレイヤーのID一覧
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

    socket.on('debugUpdateScore', ({ targetPlayerId, amount, setDirect }) => {
        const target = gameState.players[targetPlayerId];
        if (!target) return;

        resetScoreChanges();
        target.prevScore = target.score;

        if (setDirect) {
            // 直接入力された値に設定
            const newScore = Number(amount);
            target.scoreChange = newScore - target.score;
            target.score = newScore;
        } else {
            // +1000, -3000 等の加減算
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

    // 1. chooseBonus ハンドラ冒頭に resetScoreChanges() を追加
    socket.on('chooseBonus', (acceptBonus) => {
        resetScoreChanges(); // ★追加：ターン開始ボーナス時の変化をリセットしてクリアにする
        const currentTurnId = gameState.currentTurnPlayerId;
        if (socket.id !== currentTurnId || gameState.turnPhase !== 'BONUS_CHOICE') return;

        const player = gameState.players[socket.id];
        if (acceptBonus) applyScoreChange(player, 3000);
        const randomCard = getRandomAvailableCard(player);
        player.hand.push(randomCard);

        gameState.turnPhase = 'MAIN';

        const bonusLog = acceptBonus ? ' (+3000点獲得)' : '';

        // 本人向け：獲得した具体カード名を含めて送信
        socket.emit('syncGameState', {
            players: gameState.players,
            turnOrder: gameState.turnOrder,
            currentTurnPlayerId: gameState.currentTurnPlayerId,
            round: gameState.round,
            turnPhase: gameState.turnPhase,
            log: `「${randomCard.name}」を獲得しました。${bonusLog}`
        });

        // 他プレイヤー向け：カード名を伏せて送信
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

        const currentTurnId = gameState.currentTurnPlayerId; if (socket.id !== currentTurnId || gameState.turnPhase !== 'MAIN') {
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

        // playCard 内のカード種別分岐（金袋の次など）に追加
        if (card.id === 'gold_bag') {
            applyScoreChange(player, 3000);
            player.hand.splice(cardIndex, 1);
            broadcastGameState(`P${player.number} が「金袋」を使用し、+3000点獲得しました！`);
        } else if (card.id === 'disaster') { // ★ 追加[cite: 28]
            player.hand.splice(cardIndex, 1);
            executeDisasterAttack(socket.id);
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
        const currentTurnId = gameState.currentTurnPlayerId; if (socket.id !== currentTurnId || gameState.turnPhase !== 'MAIN') {
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
        const currentTurnId = gameState.currentTurnPlayerId; if (socket.id !== currentTurnId || gameState.turnPhase !== 'MAIN') return;
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

// 「木の盾」「木の盾セット」用の命中率算出関数
function getWoodShieldHitRate(attackerScore, targetScore) {
    const diff = attackerScore - targetScore; // 得点差 x
    const rate = Math.max(0, 1 - Math.abs(diff) / 10000);
    return rate; // 0.0 ～ 1.0 の確率
}

// 通常カード（木の剣 / 木の盾）の攻撃実行
function executeStandardAttack(attackerId, targetId, cardId) {
    const attacker = gameState.players[attackerId];
    const target = gameState.players[targetId];
    const cardName = cardId === 'wood_sword' ? '木の剣' : '木の盾';
    let logPrefix = `P${attacker.number} が P${target.number} に「${cardName}」で攻撃！ `;

    // 1. 命中率の判定
    let hitRate = 0.5; // 木の剣は固定50%
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

    // 2. 攻撃が失敗（ミス）した場合
    if (!isHit) {
        broadcastGameState(logPrefix + rateText + `攻撃は外れた！（ミス）`);
        return;
    }

    // 3. 攻撃成功時・ガード判定
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

    // 4. ダメージ適用
    applyScoreChange(target, -3000);
    target.immunityCount = 2; // 選択不可状態
    broadcastGameState(logPrefix + rateText + `命中ヒット！ 得点-3000点！ (P${target.number}は選択不可状態になりました)`);
}

function executeWoodSwordAttack(attackerId, targetTypeOrId) {
    const attacker = gameState.players[attackerId];

    // --- CASE 1: 自分より順位が下のプレイヤー全員への範囲攻撃 ---
    if (targetTypeOrId === 'ALL_LOWER') {
        // すでに攻撃処理を行ったプレイヤーIDを記録するセット
        const attackedPlayerIds = new Set();

        function processNextLowerTarget() {
            // 最新の全プレイヤー情報を取得
            const currentPlayers = Object.values(gameState.players);
            // 最新の攻撃者のスコアを取得
            const currentAttackerScore = gameState.players[attackerId].score;

            // 1. 最新の自分より得点が低いプレイヤーを抽出（未攻撃かつ選択不可でないプレイヤーのみ）
            const lowerPlayers = currentPlayers.filter(p =>
                p.score < currentAttackerScore &&
                !attackedPlayerIds.has(p.id) &&
                (!p.immunityCount || p.immunityCount <= 0) // ★ 選択不可状態のプレイヤーを除外
            );
            if (lowerPlayers.length === 0) {
                if (attackedPlayerIds.size === 0) {
                    broadcastGameState(`P${attacker.number} が「木の剣」を使用しましたが、自分より下の順位のプレイヤーがいませんでした。`);
                }
                return;
            }

            // 2. 得点が高い順（降順）にソート
            lowerPlayers.sort((a, b) => b.score - a.score);

            // 3. 最高得点グループを特定（同点プレイヤーのグループ化）
            const topScore = lowerPlayers[0].score;
            const topGroup = lowerPlayers.filter(p => p.score === topScore);

            // 4. 同点グループの中からランダムに1人を選択
            const target = topGroup[Math.floor(Math.random() * topGroup.length)];

            // 攻撃対象として記録
            attackedPlayerIds.add(target.id);

            let logPrefix = `P${attacker.number} の「木の剣」攻撃 (対象: P${target.number})！ `;

            // 命中判定（1/2）
            const isHit = Math.random() < 0.5;

            // 攻撃失敗（ミス）の場合：連続攻撃を継続して次の順位の対象へ
            if (!isHit) {
                broadcastGameState(logPrefix + `攻撃は外れた！（ミス）`);
                setTimeout(processNextLowerTarget, 500);
                return;
            }

            // 防御カードチェック
            if (target.defenseCard) {
                // ★追加: 防御カードが「木の剣」かつ、攻撃者が防御者より高得点の場合は無効化不可
                const isWoodSwordDefense = target.defenseCard.card.id === 'wood_sword';
                const isAttackerHigherScore = attacker.score > target.score;

                if (isWoodSwordDefense && isAttackerHigherScore) {
                    broadcastGameState(logPrefix + `命中！相手は「木の剣」をセット中ですが、自分より得点が高いプレイヤーからの攻撃のため防御効果が発動しません！`);
                    // return せずにそのまま下のダメージ適用処理へ進む
                } else {
                    target.defenseCard.usesLeft -= 1;
                    let msg = logPrefix + `命中！しかし相手の防御カード「${target.defenseCard.card.name}」で無効化されました！`;
                    if (target.defenseCard.usesLeft <= 0) {
                        target.defenseCard = null;
                        msg += '（相手の防御カード破棄）';
                    }
                    broadcastGameState(msg);
                    return; // ★ 防御カードでの無効化時も範囲攻撃を中断
                }
            }

            // ダメージ適用（得点変動）＆ 攻撃中断
            applyScoreChange(target, -3000);
            target.immunityCount = 2;
            broadcastGameState(logPrefix + `命中ヒット！ 得点-3000点！ (P${target.number}は選択不可状態になりました。)`);
            return;
        }

        processNextLowerTarget();
        return;
    }

    // --- CASE 2: 自分との得点差が0点以上+5000点以下のプレイヤー単体への攻撃 ---
    const target = gameState.players[targetTypeOrId];
    if (!target) return;

    const scoreDiff = target.score - attacker.score;

    // バリデーションチェック: 得点差が0未満（自分より得点が低い）または5000点を超える場合は攻撃不可
    if (scoreDiff < 0 || scoreDiff > 5000) {
        const socket = io.sockets.sockets.get(attackerId);
        if (socket) {
            socket.emit('errorMessage', '自分との得点差が0点以上+5000点以下のプレイヤーのみ攻撃対象に指定できます。');
        }
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
        // 防御カードが「木の剣」かつ、攻撃者が防御者より高得点の場合は無効化不可
        const isWoodSwordDefense = target.defenseCard.card.id === 'wood_sword';
        const isAttackerHigherScore = attacker.score > target.score;

        if (isWoodSwordDefense && isAttackerHigherScore) {
            broadcastGameState(logPrefix + `(成功率:50%) 命中！相手は「木の剣」をセット中ですが、自分より得点が高いプレイヤーからの攻撃のため防御効果が発動しません！`);
            // ここで return せず後続のダメージ処理へ進む（防御カードも削除しない）
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

// 木の盾セットのまとめ攻撃処理
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

        // 1. 成功率の判定
        const isHit = Math.random() < hitRate;

        // 2. 失敗（ミス）した場合
        if (!isHit) {
            broadcastGameState(logPrefix + `(命中率:${ratePercent}%) 攻撃は外れた！（ミス）`);
            setTimeout(doNextAttack, 500);
            return;
        }

        // 3. 成功した場合・ガード判定
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

        // 4. 防御カードがない場合：ダメージ適用して攻撃中断
        applyScoreChange(target, -3000);
        target.immunityCount = 2;
        broadcastGameState(logPrefix + `(命中率:${ratePercent}%) 命中ヒット！ 得点-3000点！ (P${target.number}が選択不可状態になったため攻撃中断)`);

        onComplete();
    }

    doNextAttack();
}

// 大災害カードの実行処理
function executeDisasterAttack(casterSocketId) {
    const caster = gameState.players[casterSocketId];

    // 1. 大災害発動直前の全プレイヤーのスコア・順位スナップショットを作成
    const initialPlayers = Object.values(gameState.players).map(p => ({
        id: p.id,
        score: p.score
    }));

    // 自分より得点が高いプレイヤーの数 + 1 を順位とする（同点の場合は同じ順位・同じマイナス点）
    const rankMap = {};
    initialPlayers.forEach(p => {
        const higherCount = initialPlayers.filter(other => other.score > p.score).length;
        rankMap[p.id] = higherCount + 1;
    });

    // 順位に応じたダメージ定義
    const damageByRank = {
        1: -6000,
        2: -4000,
        3: -2000,
        4: -1000
    };

    // 2. 使用者以外の全員に効果を適用
    Object.values(gameState.players).forEach(player => {
        if (player.id === casterSocketId) return; // 使用者自身は除外

        const rank = rankMap[player.id];
        const damage = damageByRank[rank] || 0;

        // ★ 選択不可状態（immunityCount > 0）でない場合のみ得点ダメージを適用
        if (!player.immunityCount || player.immunityCount <= 0) {
            applyScoreChange(player, damage);

            // 選択不可状態（1巡分）を新規付与
            player.immunityCount = 2;
        }

        // 手札・防御カードを全破棄（すでに選択不可状態のプレイヤーにも適用）
        player.hand = [];
        player.defenseCard = null;
    });

    // 3. ゲーム状態の全体同期とログ出力
    broadcastGameState(`P${caster.number} が「大災害」を発動！(選択不可状態のプレイヤーはダメージ無効化)`);
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

    // 得点順でソート
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

    // ターンを終えたプレイヤーを「行動済み」に記録
    if (endingPlayerId && !gameState.actedPlayerIds.includes(endingPlayerId)) {
        gameState.actedPlayerIds.push(endingPlayerId);
    }

    // ターンを終えたプレイヤー以外の「選択不可状態」のカウントを減らす
    Object.values(gameState.players).forEach(p => {
        if (p.id !== endingPlayerId && p.immunityCount && p.immunityCount > 0) {
            p.immunityCount -= 1;
        }
    });

    // 全員がこの巡目で行動を終えたか判定
    if (gameState.actedPlayerIds.length >= Object.keys(gameState.players).length) {
        // --- 巡目の終了と次の巡目の準備 ---
        gameState.actedPlayerIds = []; // 行動済みリストをリセット
        gameState.round++;

        if (gameState.round > 10) {
            const winner = Object.values(gameState.players).sort((a, b) => b.score - a.score)[0];
            io.emit('gameOver', { winner, players: gameState.players });
            return;
        }
    }

    // ★現在の最新スコア順でプレイヤーをソート（降順）
    const sortedPlayers = Object.values(gameState.players).sort((a, b) => b.score - a.score);
    gameState.turnOrder = sortedPlayers.map(p => p.id);

    // ★まだ行動していない最高順位のプレイヤーを探す
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

// 2. applyScoreChange から resetScoreChanges() の呼び出しを削除
function applyScoreChange(player, amount) {
    // resetScoreChanges(); ← この行を削除して複数人のスコア変動情報を維持できるようにする
    player.prevScore = player.score;
    player.scoreChange = amount;
    player.score += amount;
}

server.listen(3000, () => console.log('Server running on http://localhost:3000'));