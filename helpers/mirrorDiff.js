'use strict';

/**
 * mirrorDiff — diff a target mirror against a document's head and produce
 * the commit ops that transform head into target. Nodes are matched by id
 * (restores and paint normalization keep element ids), attributes by name;
 * an added attribute's insert position is its index in the target's ordered
 * attribute list, and text and comment content becomes a plain value write.
 * Removals come before additions, additions parent-first. Shared by
 * DocumentManager's restore path and PaintNormalizer's stability check.
 */

function diffMirrors(handle, target) {

	const ops = [];

	// Every node in the target, by eid.
	const targetNodes = new Map();
	const walkTarget = (eid) => {
		const node = target.get(eid);
		if (!node) return;
		targetNodes.set(eid, node);
		for (const child of node.kids) walkTarget(child);
	};
	const rootKids = target.get(0)?.kids || [];
	rootKids.forEach((eid) => walkTarget(eid));
	// The root can only ever hold one element child (html).
	if (rootKids.length > 1) {
		throw new Error('Cannot restore: document has multiple root elements.');
	}

	const NODE_TEXT = 3, NODE_COMMENT = 8;
	const attrOps = (eid, fromNode, toNode) => {
		const fromAttrs = new Map();
		if (fromNode) {
			for (const attr of fromNode.attrs) {
				if (attr.n !== null) fromAttrs.set(attr.n, attr.v);
			}
		}
		// A new attribute inserts at its position in the target's own
		// ordered list (an existing name updates in place — i advisory).
		toNode.attrs.forEach((attr, i) => {
			if (attr.n === null) return;
			const oldV = fromAttrs.get(attr.n);
			if (oldV === undefined || oldV !== attr.v) {
				ops.push({ k: 'aa', e: eid, i, n: attr.n, v: attr.v });
			}
			fromAttrs.delete(attr.n);
		});
		for (const name of fromAttrs.keys()) {
			ops.push({ k: 'ar', e: eid, n: name });
		}
	};

	// Head nodes not in the target get removed — but only the topmost ones
	// (their descendants come along), so the op log stays readable and the
	// applier doesn't warn about already-removed nodes.
	const removed = new Set();
	for (const [eid, node] of handle.nodes) {
		if (eid === 0 || targetNodes.has(eid)) continue;
		let ancestorRemoved = false;
		let p = node.p;
		while (p > 0) {
			if (removed.has(p)) { ancestorRemoved = true; break; }
			p = handle.nodes.get(p)?.p ?? -1;
		}
		if (!ancestorRemoved) {
			removed.add(eid);
			ops.push({ k: 'sr', p: node.p, e: eid });
		}
	}

	const visit = (eid, parentId, index, headNode) => {
		const targetNode = targetNodes.get(eid);
		if (!targetNode) return;
		// Structural fix-up: the node must sit at (parentId, index).
		if (!headNode || headNode.p !== parentId
			|| handle.nodes.get(parentId)?.kids[index] !== eid) {
			// An attached node at the wrong place needs a real move (sr+sa):
			// the applier drops a lone sa for an attached node.
			if (headNode) ops.push({ k: 'sr', p: headNode.p, e: eid });
			ops.push({ k: 'sa', p: parentId, i: index, e: eid, t: targetNode.t,
				n: targetNode.n });
		}
		attrOps(eid, headNode, targetNode);

		// Head children not in the target get removed — except the ones the
		// topmost-removal pass above already removed (their sr is on the
		// list; the applier would skip the duplicate with a warning).
		if (headNode) {
			for (const childEid of headNode.kids) {
				if (!targetNodes.has(childEid) && !removed.has(childEid)) {
					ops.push({ k: 'sr', p: eid, e: childEid });
				}
			}
		}
		targetNode.kids.forEach((childEid, i) => {
			visit(childEid, eid, i, handle.nodes.get(childEid));
		});
	};

	rootKids.forEach((eid, i) => visit(eid, 0, i, handle.nodes.get(eid)));

	// Content of text/comment nodes becomes a plain value write (the eid
	// alone addresses it — position 0 is the node's only entry).
	for (const [eid, node] of targetNodes) {
		if (node.t !== NODE_TEXT && node.t !== NODE_COMMENT) continue;
		const headNode = handle.nodes.get(eid);
		const headContent = headNode ? headNode.attrs[0] : null;
		const targetContent = node.attrs[0];
		if (headContent?.v !== targetContent?.v) {
			ops.push({ k: 'aa', e: eid, n: null,
				v: targetContent ? targetContent.v : '' });
		}
	}

	return ops;
}


module.exports = diffMirrors;
