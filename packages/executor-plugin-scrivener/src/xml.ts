/**
 * A faithful XML layer for Scrivener's .scrivx.
 *
 * Scrivener carries load-bearing information in attributes: a binder item's
 * identity is `UUID`, its kind is `Type`, and a label definition's identity is
 * `ID`. The common convenience of merging attributes into an element's children
 * — one option flag in most parsers — destroys that on the way back out,
 * turning `<Label ID="7">DAWN</Label>` into `<Label><ID>7</ID>DAWN</Label>`.
 * Scrivener then reads a project with no labels and no item types.
 *
 * So the document is held in ordered form, where attributes stay in their own
 * `:@` slot and sibling order survives, and edits are made in place against
 * that tree rather than by rebuilding it from a convenient shape.
 */

import { XMLBuilder, XMLParser } from 'fast-xml-parser';

const ATTR = ':@';
const TEXT = '#text';
const PREFIX = '@_';

/** Attribute bag, keyed with the parser's prefix. */
export type XmlAttrs = Record<string, string>;

/**
 * One node in ordered form: an element is a single tag key whose value is a
 * child array, optionally with an `:@` attribute bag; a text node is a lone
 * `#text` key. Values are `unknown` so every read goes through a narrowing
 * helper below rather than an assertion at the call site.
 */
export type XmlNode = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The element's tag, or undefined for a text node. */
export function tagOf(node: XmlNode): string | undefined {
	for (const key of Object.keys(node)) {
		if (key !== ATTR && key !== TEXT) return key;
	}
	return undefined;
}

export function isTextNode(node: XmlNode): boolean {
	return TEXT in node;
}

/** The element's live child array — mutating it edits the document. */
export function childrenOf(node: XmlNode): XmlNode[] {
	const tag = tagOf(node);
	if (tag === undefined) return [];
	const value = node[tag];
	if (Array.isArray(value)) return value as XmlNode[];
	const created: XmlNode[] = [];
	node[tag] = created;
	return created;
}

export function getAttr(node: XmlNode, name: string): string | undefined {
	const bag = node[ATTR];
	if (!isRecord(bag)) return undefined;
	const value = bag[`${PREFIX}${name}`];
	return value === undefined ? undefined : String(value);
}

export function setAttr(node: XmlNode, name: string, value: string): void {
	let bag = node[ATTR];
	if (!isRecord(bag)) {
		bag = {};
		node[ATTR] = bag;
	}
	(bag as XmlAttrs)[`${PREFIX}${name}`] = value;
}

export function findChild(node: XmlNode, tag: string): XmlNode | undefined {
	return childrenOf(node).find((child) => tagOf(child) === tag);
}

export function findChildren(node: XmlNode, tag: string): XmlNode[] {
	return childrenOf(node).filter((child) => tagOf(child) === tag);
}

/** The child with this tag, appended if it is not already there. */
export function ensureChild(node: XmlNode, tag: string): XmlNode {
	const existing = findChild(node, tag);
	if (existing) return existing;
	const created: XmlNode = { [tag]: [] };
	childrenOf(node).push(created);
	return created;
}

export function removeChild(node: XmlNode, tag: string): boolean {
	const children = childrenOf(node);
	const index = children.findIndex((child) => tagOf(child) === tag);
	if (index === -1) return false;
	children.splice(index, 1);
	return true;
}

export function textOf(node: XmlNode): string {
	return childrenOf(node)
		.filter(isTextNode)
		.map((child) => String(child[TEXT] ?? ''))
		.join('');
}

export function setText(node: XmlNode, value: string): void {
	const tag = tagOf(node);
	if (tag === undefined) return;
	node[tag] = [{ [TEXT]: value }];
}

export function element(tag: string, children: XmlNode[] = []): XmlNode {
	return { [tag]: children };
}

export function textElement(tag: string, value: string): XmlNode {
	return { [tag]: [{ [TEXT]: value }] };
}

const SHARED = {
	preserveOrder: true,
	ignoreAttributes: false,
	attributeNamePrefix: PREFIX,
	ignoreDeclaration: false,
	parseTagValue: false,
	parseAttributeValue: false,
	trimValues: true,
} as const;

export function parseXml(xml: string): XmlNode[] {
	const parsed = new XMLParser(SHARED).parse(xml) as unknown;
	return Array.isArray(parsed) ? (parsed as XmlNode[]) : [];
}

export function buildXml(tree: XmlNode[]): string {
	const builder = new XMLBuilder({
		...SHARED,
		format: true,
		indentBy: '    ',
		suppressEmptyNode: false,
	});
	return String(builder.build(tree));
}

/**
 * Drop text nodes that are only whitespace.
 *
 * Indentation is parsed as content, so without this a document gains a fresh
 * layer of blank lines every time it is formatted on the way out, and after a
 * few passes the file is mostly whitespace. Elements that hold real text keep
 * it: only entirely blank runs go.
 */
export function stripLayoutWhitespace(nodes: XmlNode[]): XmlNode[] {
	const kept: XmlNode[] = [];
	for (const node of nodes) {
		if (isTextNode(node) && String(node[TEXT] ?? '').trim() === '') continue;
		const tag = tagOf(node);
		if (tag !== undefined && Array.isArray(node[tag])) {
			node[tag] = stripLayoutWhitespace(node[tag] as XmlNode[]);
		}
		kept.push(node);
	}
	return kept;
}

/** Find the first element with this tag anywhere in the tree. */
export function findDescendant(nodes: XmlNode[], tag: string): XmlNode | undefined {
	for (const node of nodes) {
		if (tagOf(node) === tag) return node;
		const found = findDescendant(childrenOf(node), tag);
		if (found) return found;
	}
	return undefined;
}
