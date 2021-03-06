import { getOrderId, getVammNodeGenerator, NodeList } from './NodeList';
import {
	BN,
	isAuctionComplete,
	isOneOfVariant,
	isVariant,
	OraclePriceData,
	Order,
	ZERO,
} from '@drift-labs/sdk';
import { PublicKey } from '@solana/web3.js';
import { DLOBNode, DLOBNodeType, TriggerOrderNode } from './DLOBNode';

export type MarketNodeLists = {
	limit: {
		ask: NodeList<'limit'>;
		bid: NodeList<'limit'>;
	};
	floatingLimit: {
		ask: NodeList<'floatingLimit'>;
		bid: NodeList<'floatingLimit'>;
	};
	market: {
		ask: NodeList<'market'>;
		bid: NodeList<'market'>;
	};
	trigger: {
		above: NodeList<'trigger'>;
		below: NodeList<'trigger'>;
	};
};

type OrderBookCallback = () => void;

export type NodeToFill = {
	node: DLOBNode;
	makerNode?: DLOBNode;
};

// maker node must be there for crossed nodes
type CrossedNodesToFill = NodeToFill & {
	makerNode: DLOBNode;
};

export type NodeToTrigger = {
	node: TriggerOrderNode;
};

type Side = 'ask' | 'bid';

export class DLOB {
	openOrders = new Set<string>();
	orderLists = new Map<number, MarketNodeLists>();

	public constructor(marketIndexes: BN[]) {
		for (const marketIndex of marketIndexes) {
			this.orderLists.set(marketIndex.toNumber(), {
				limit: {
					ask: new NodeList('limit', marketIndex, 'asc'),
					bid: new NodeList('limit', marketIndex, 'desc'),
				},
				floatingLimit: {
					ask: new NodeList('floatingLimit', marketIndex, 'asc'),
					bid: new NodeList('floatingLimit', marketIndex, 'desc'),
				},
				market: {
					ask: new NodeList('market', marketIndex, 'asc'),
					bid: new NodeList('market', marketIndex, 'asc'), // always sort ascending for market orders
				},
				trigger: {
					above: new NodeList('trigger', marketIndex, 'asc'),
					below: new NodeList('trigger', marketIndex, 'desc'),
				},
			});
		}
	}

	public insert(
		order: Order,
		userAccount: PublicKey,
		onInsert?: OrderBookCallback
	): void {
		if (isVariant(order, 'init')) {
			return;
		}

		if (isVariant(order.status, 'open')) {
			this.openOrders.add(this.getOpenOrderId(order, userAccount));
		}
		this.getListForOrder(order).insert(order, userAccount);

		if (onInsert) {
			onInsert();
		}
	}

	public remove(
		order: Order,
		userAccount: PublicKey,
		onRemove?: OrderBookCallback
	): void {
		this.openOrders.delete(this.getOpenOrderId(order, userAccount));
		this.getListForOrder(order).remove(order, userAccount);

		if (onRemove) {
			onRemove();
		}
	}

	public update(
		order: Order,
		userAccount: PublicKey,
		onUpdate?: OrderBookCallback
	): void {
		this.getListForOrder(order).update(order, userAccount);
		if (onUpdate) {
			onUpdate();
		}
	}

	public trigger(
		order: Order,
		userAccount: PublicKey,
		onTrigger?: OrderBookCallback
	): void {
		const triggerList = this.orderLists.get(order.marketIndex.toNumber())
			.trigger[isVariant(order.triggerCondition, 'above') ? 'above' : 'below'];
		triggerList.remove(order, userAccount);

		this.getListForOrder(order).insert(order, userAccount);
		if (onTrigger) {
			onTrigger();
		}
	}

	public getListForOrder(order: Order): NodeList<any> {
		const isInactiveTriggerOrder =
			isOneOfVariant(order.orderType, ['triggerMarket', 'triggerLimit']) &&
			!order.triggered;

		let type: DLOBNodeType;
		if (isInactiveTriggerOrder) {
			type = 'trigger';
		} else if (isOneOfVariant(order.orderType, ['market', 'triggerMarket'])) {
			type = 'market';
		} else if (order.oraclePriceOffset.gt(ZERO)) {
			type = 'floatingLimit';
		} else {
			type = 'limit';
		}

		let subType: string;
		if (isInactiveTriggerOrder) {
			subType = isVariant(order.triggerCondition, 'above') ? 'above' : 'below';
		} else {
			subType = isVariant(order.direction, 'long') ? 'bid' : 'ask';
		}

		return this.orderLists.get(order.marketIndex.toNumber())[type][subType];
	}

	public getOpenOrderId(order: Order, userAccount: PublicKey): string {
		return getOrderId(order, userAccount);
	}

	public findNodesToFill(
		marketIndex: BN,
		vBid: BN,
		vAsk: BN,
		slot: number,
		oraclePriceData?: OraclePriceData
	): NodeToFill[] {
		// Find all the crossing nodes
		const crossingNodesToFill: Array<NodeToFill> = this.findCrossingNodesToFill(
			marketIndex,
			vBid,
			vAsk,
			slot,
			oraclePriceData
		);
		// Find all market nodes to fill
		const marketNodesToFill = this.findMarketNodesToFill(marketIndex, slot);
		return crossingNodesToFill.concat(marketNodesToFill);
	}

	public findCrossingNodesToFill(
		marketIndex: BN,
		vBid: BN,
		vAsk: BN,
		slot: number,
		oraclePriceData?: OraclePriceData
	): CrossedNodesToFill[] {
		const nodesToFill = new Array<CrossedNodesToFill>();

		const askGenerator = this.getAsks(marketIndex, vAsk, slot, oraclePriceData);
		const bidGenerator = this.getBids(marketIndex, vBid, slot, oraclePriceData);

		let nextAsk = askGenerator.next();
		let nextBid = bidGenerator.next();

		// First try to find orders that cross
		while (!nextAsk.done && !nextBid.done) {
			const { crossingNodes, crossingSide } = this.findCrossingOrders(
				nextAsk.value,
				askGenerator,
				nextBid.value,
				bidGenerator,
				oraclePriceData,
				slot
			);

			if (crossingNodes) {
				nodesToFill.push(crossingNodes);
				if (nodesToFill.length === 10) {
					break;
				}
			}

			if (crossingSide === 'bid') {
				nextBid = bidGenerator.next();
			} else if (crossingSide === 'ask') {
				nextAsk = askGenerator.next();
			} else {
				break;
			}
		}
		return nodesToFill;
	}

	public findMarketNodesToFill(marketIndex: BN, slot: number): NodeToFill[] {
		const nodesToFill = new Array<NodeToFill>();
		// Then see if there are orders to fill against vamm
		for (const marketBid of this.getMarketBids(marketIndex)) {
			if (isAuctionComplete(marketBid.order, slot)) {
				nodesToFill.push({
					node: marketBid,
				});
			}
		}

		for (const marketAsk of this.getMarketAsks(marketIndex)) {
			if (isAuctionComplete(marketAsk.order, slot)) {
				nodesToFill.push({
					node: marketAsk,
				});
			}
		}
		return nodesToFill;
	}

	public getMarketBids(marketIndex: BN): Generator<DLOBNode> {
		return this.orderLists
			.get(marketIndex.toNumber())
			.market.bid.getGenerator();
	}

	public getMarketAsks(marketIndex: BN): Generator<DLOBNode> {
		return this.orderLists
			.get(marketIndex.toNumber())
			.market.ask.getGenerator();
	}

	*getAsks(
		marketIndex: BN,
		vAsk: BN,
		slot: number,
		oraclePriceData?: OraclePriceData
	): Generator<DLOBNode> {
		const nodeLists = this.orderLists.get(marketIndex.toNumber());

		const generators = [
			nodeLists.limit.ask.getGenerator(),
			nodeLists.floatingLimit.ask.getGenerator(),
			nodeLists.market.ask.getGenerator(),
			getVammNodeGenerator(vAsk),
		].map((generator) => {
			return {
				next: generator.next(),
				generator,
			};
		});

		let asksExhausted = false;
		while (!asksExhausted) {
			const bestGenerator = generators.reduce(
				(bestGenerator, currentGenerator) => {
					if (currentGenerator.next.done) {
						return bestGenerator;
					}

					if (bestGenerator.next.done) {
						return currentGenerator;
					}

					const bestAskPrice = bestGenerator.next.value.getPrice(
						oraclePriceData,
						slot
					);
					const currentAskPrice = currentGenerator.next.value.getPrice(
						oraclePriceData,
						slot
					);

					return bestAskPrice.lt(currentAskPrice)
						? bestGenerator
						: currentGenerator;
				}
			);

			if (!bestGenerator.next.done) {
				yield bestGenerator.next.value;
				bestGenerator.next = bestGenerator.generator.next();
			} else {
				asksExhausted = true;
			}
		}
	}

	*getBids(
		marketIndex: BN,
		vBid: BN,
		slot: number,
		oraclePriceData?: OraclePriceData
	): Generator<DLOBNode> {
		const nodeLists = this.orderLists.get(marketIndex.toNumber());

		const bidGenerators = [
			nodeLists.limit.bid.getGenerator(),
			nodeLists.floatingLimit.bid.getGenerator(),
			nodeLists.market.bid.getGenerator(),
			getVammNodeGenerator(vBid),
		].map((generator) => {
			return {
				next: generator.next(),
				generator,
			};
		});

		let bidsExhausted = false; // there will always be the vBid
		while (!bidsExhausted) {
			const bestGenerator = bidGenerators.reduce(
				(bestGenerator, currentGenerator) => {
					if (currentGenerator.next.done) {
						return bestGenerator;
					}

					if (bestGenerator.next.done) {
						return currentGenerator;
					}

					const bestBidPrice = bestGenerator.next.value.getPrice(
						oraclePriceData,
						slot
					);
					const currentBidPrice = currentGenerator.next.value.getPrice(
						oraclePriceData,
						slot
					);

					return bestBidPrice.gt(currentBidPrice)
						? bestGenerator
						: currentGenerator;
				}
			);

			if (!bestGenerator.next.done) {
				yield bestGenerator.next.value;
				bestGenerator.next = bestGenerator.generator.next();
			} else {
				bidsExhausted = true;
			}
		}
	}

	findCrossingOrders(
		askNode: DLOBNode,
		askGenerator: Generator<DLOBNode>,
		bidNode: DLOBNode,
		bidGenerator: Generator<DLOBNode>,
		oraclePriceData: OraclePriceData,
		slot: number
	): {
		crossingNodes?: CrossedNodesToFill;
		crossingSide?: Side;
	} {
		const bidPrice = bidNode.getPrice(oraclePriceData, slot);
		const askPrice = askNode.getPrice(oraclePriceData, slot);
		// no cross
		if (bidPrice.lt(askPrice)) {
			return {};
		}

		// User bid crosses the vamm ask
		// Cant match orders
		if (askNode.isVammNode()) {
			return {
				crossingSide: 'bid',
			};
		}

		// User ask crosses the vamm bid
		// Cant match orders
		if (bidNode.isVammNode()) {
			return {
				crossingSide: 'ask',
			};
		}

		const bidOrder = bidNode.order;
		const askOrder = askNode.order;

		// Two maker orders cross
		if (bidOrder.postOnly && askOrder.postOnly) {
			return {
				crossingSide: bidOrder.ts.lt(askOrder.ts) ? 'bid' : 'ask',
			};
		}

		// Bid is maker
		if (bidOrder.postOnly) {
			return {
				crossingNodes: {
					node: askNode,
					makerNode: bidNode,
				},
				crossingSide: 'ask',
			};
		}

		// Ask is maker
		if (askOrder.postOnly) {
			return {
				crossingNodes: {
					node: bidNode,
					makerNode: askNode,
				},
				crossingSide: 'bid',
			};
		}

		// Both are takers
		// older order is maker
		const newerNode = bidOrder.ts.lt(askOrder.ts) ? askNode : bidNode;
		const olderNode = askOrder.ts.lt(bidOrder.ts) ? bidNode : askNode;
		const crossingSide = askOrder.ts.lt(bidOrder.ts) ? 'bid' : 'ask';
		return {
			crossingNodes: {
				node: newerNode,
				makerNode: olderNode,
			},
			crossingSide,
		};
	}

	public getBestAsk(
		marketIndex: BN,
		vAsk: BN,
		slot: number,
		oraclePriceData: OraclePriceData
	): BN {
		return this.getAsks(marketIndex, vAsk, slot, oraclePriceData)
			.next()
			.value.getPrice(oraclePriceData, slot);
	}

	public getBestBid(
		marketIndex: BN,
		vBid: BN,
		slot: number,
		oraclePriceData: OraclePriceData
	): BN {
		return this.getBids(marketIndex, vBid, slot, oraclePriceData)
			.next()
			.value.getPrice(oraclePriceData, slot);
	}

	public findNodesToTrigger(
		marketIndex: BN,
		slot: number,
		oraclePrice: BN
	): NodeToTrigger[] {
		const nodesToTrigger = [];
		for (const node of this.orderLists
			.get(marketIndex.toNumber())
			.trigger.above.getGenerator()) {
			if (oraclePrice.gt(node.order.triggerPrice)) {
				if (isAuctionComplete(node.order, slot)) {
					nodesToTrigger.push({
						node: node,
					});
				}
			} else {
				break;
			}
		}

		for (const node of this.orderLists
			.get(marketIndex.toNumber())
			.trigger.below.getGenerator()) {
			if (oraclePrice.lt(node.order.triggerPrice)) {
				if (isAuctionComplete(node.order, slot)) {
					nodesToTrigger.push({
						node: node,
					});
				}
			} else {
				break;
			}
		}

		return nodesToTrigger;
	}
}
