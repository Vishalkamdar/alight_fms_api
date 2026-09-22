import Papa from "papaparse";
import { Types } from "mongoose";
import { AppError } from "../utils/AppError";
import { logActivity } from "../utils/activity-log";
import { NodeTypeModel } from "../models/NodeType";
import { OrganizationNodeModel, type OrganizationNodeDocument } from "../models/OrganizationNode";

const MAX_ROWS = 2000;
const PATH_SEPARATOR = ">";
const MAX_RESOLUTION_PASSES = 50;

export interface BulkImportRowResult {
  row: number;
  name: string;
  status: "created" | "skipped" | "failed";
  message?: string;
}

export interface BulkImportResult {
  dryRun: boolean;
  summary: { total: number; created: number; skipped: number; failed: number };
  rows: BulkImportRowResult[];
}

interface ParsedRow {
  row: number;
  name: string;
  nodeTypeCode: string;
  parentPath: string; // "" means root
  displayOrder: number;
  status: "Active" | "Inactive";
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findColumn(headerMap: Map<string, string>, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const original = headerMap.get(candidate);
    if (original) return original;
  }
  return null;
}

function buildFullPath(parentPath: string, name: string): string {
  return parentPath ? `${parentPath} ${PATH_SEPARATOR} ${name}` : name;
}

/**
 * Walks every existing node's parentNodeId chain to seed the "known path"
 * map bulk-import rows resolve their parent against — lets a CSV reference
 * a parent that already exists in the DB, not just one created in the same file.
 */
function buildExistingPathMap(nodes: OrganizationNodeDocument[]): Map<string, Types.ObjectId> {
  const byId = new Map(nodes.map((node) => [String(node._id), node]));
  const pathCache = new Map<string, string>();

  function resolvePath(nodeId: string): string {
    const cached = pathCache.get(nodeId);
    if (cached !== undefined) return cached;

    const node = byId.get(nodeId);
    if (!node) return "";

    const parentId = node.parentNodeId ? String(node.parentNodeId) : null;
    const fullPath = parentId ? buildFullPath(resolvePath(parentId), node.name) : node.name;
    pathCache.set(nodeId, fullPath);
    return fullPath;
  }

  const result = new Map<string, Types.ObjectId>();
  for (const node of nodes) {
    result.set(resolvePath(String(node._id)).toLowerCase(), node._id);
  }
  return result;
}

function parseCsv(buffer: Buffer): ParsedRow[] {
  const text = buffer.toString("utf-8");
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });

  if (parsed.errors.length > 0) {
    throw new AppError(422, `Could not parse the CSV file: ${parsed.errors[0].message}`);
  }

  const rawHeaders = parsed.meta.fields ?? [];
  if (rawHeaders.length === 0) {
    throw new AppError(422, "The CSV file has no header row.");
  }

  const headerMap = new Map(rawHeaders.map((header) => [normalizeHeader(header), header]));
  const nameCol = findColumn(headerMap, ["name", "nodename"]);
  const nodeTypeCol = findColumn(headerMap, ["nodetypecode", "nodetype", "type", "typecode"]);
  const parentCol = findColumn(headerMap, ["parentpath", "parent", "parentnode"]);
  const displayOrderCol = findColumn(headerMap, ["displayorder", "order"]);
  const statusCol = findColumn(headerMap, ["status"]);

  if (!nameCol || !nodeTypeCol) {
    throw new AppError(
      422,
      'The CSV must include at least "Name" and "Node Type Code" columns.'
    );
  }

  if (parsed.data.length === 0) {
    throw new AppError(422, "The CSV file has no data rows.");
  }
  if (parsed.data.length > MAX_ROWS) {
    throw new AppError(422, `A single import is limited to ${MAX_ROWS} rows.`);
  }

  return parsed.data.map((record, index) => {
    const displayOrderRaw = displayOrderCol ? record[displayOrderCol]?.trim() : "";
    const displayOrder = displayOrderRaw ? Number.parseInt(displayOrderRaw, 10) : 0;
    const statusRaw = (statusCol ? record[statusCol]?.trim() : "") || "Active";
    const status = /^inactive$/i.test(statusRaw) ? "Inactive" : "Active";

    return {
      row: index + 2, // +1 for 0-index, +1 for the header row
      name: (record[nameCol] ?? "").trim(),
      nodeTypeCode: (record[nodeTypeCol] ?? "").trim(),
      parentPath: (parentCol ? record[parentCol] : "")
        .split(PATH_SEPARATOR)
        .map((segment) => segment.trim())
        .filter(Boolean)
        .join(` ${PATH_SEPARATOR} `),
      displayOrder: Number.isFinite(displayOrder) && displayOrder >= 0 ? displayOrder : 0,
      status,
    };
  });
}

export async function bulkImportOrganizationNodes(
  csvBuffer: Buffer,
  actorId: Types.ObjectId,
  context: { ipAddress: string | null; userAgent?: string | null; fileName?: string },
  dryRun: boolean
): Promise<BulkImportResult> {
  const rows = parseCsv(csvBuffer);

  const [nodeTypes, existingNodes] = await Promise.all([
    NodeTypeModel.find().select("code").lean(),
    OrganizationNodeModel.find().select("name parentNodeId nodeTypeId").lean<OrganizationNodeDocument[]>(),
  ]);

  const nodeTypeByCode = new Map(nodeTypes.map((nt) => [nt.code.toUpperCase(), nt._id]));
  const resolvedPaths = buildExistingPathMap(existingNodes);

  // (parentId string, name lowercased) -> true, to skip exact duplicates already in the DB.
  const existingDuplicateKeys = new Set(
    existingNodes.map((node) => `${node.parentNodeId ? String(node.parentNodeId) : "root"}::${node.name.toLowerCase()}`)
  );
  const importedDuplicateKeys = new Set<string>();

  const results = new Map<number, BulkImportRowResult>();
  const pending = new Map<number, ParsedRow>();

  for (const row of rows) {
    if (!row.name || row.name.length < 2) {
      results.set(row.row, { row: row.row, name: row.name, status: "failed", message: "Name is required (min 2 characters)." });
      continue;
    }
    if (!row.nodeTypeCode) {
      results.set(row.row, { row: row.row, name: row.name, status: "failed", message: "Node Type Code is required." });
      continue;
    }
    if (!nodeTypeByCode.has(row.nodeTypeCode.toUpperCase())) {
      results.set(row.row, {
        row: row.row,
        name: row.name,
        status: "failed",
        message: `Unknown node type code "${row.nodeTypeCode}".`,
      });
      continue;
    }
    pending.set(row.row, row);
  }

  let progressed = true;
  let pass = 0;
  while (pending.size > 0 && progressed && pass < MAX_RESOLUTION_PASSES) {
    progressed = false;
    pass += 1;

    for (const [rowNumber, row] of [...pending]) {
      const parentKey = row.parentPath.toLowerCase();
      const parentId = row.parentPath === "" ? null : (resolvedPaths.get(parentKey) ?? undefined);

      if (parentId === undefined) continue; // parent not resolved yet — try again next pass

      pending.delete(rowNumber);
      progressed = true;

      const duplicateKey = `${parentId ? String(parentId) : "root"}::${row.name.toLowerCase()}`;
      if (existingDuplicateKeys.has(duplicateKey) || importedDuplicateKeys.has(duplicateKey)) {
        results.set(rowNumber, {
          row: rowNumber,
          name: row.name,
          status: "skipped",
          message: "A node with this name already exists under the same parent — skipped.",
        });
        // If it pre-existed in the DB, buildExistingPathMap already seeded its
        // real path/id above, so descendants in the file resolve against it
        // as-is — nothing to do here for either case.
        continue;
      }

      const nodeTypeId = nodeTypeByCode.get(row.nodeTypeCode.toUpperCase())!;
      let newId: Types.ObjectId;

      if (dryRun) {
        newId = new Types.ObjectId();
      } else {
        const created = await OrganizationNodeModel.create({
          name: row.name,
          nodeTypeId,
          parentNodeId: parentId,
          status: row.status,
          displayOrder: row.displayOrder,
          createdBy: actorId,
          updatedBy: actorId,
        });
        newId = created._id;
      }

      importedDuplicateKeys.add(duplicateKey);
      resolvedPaths.set(buildFullPath(row.parentPath, row.name).toLowerCase(), newId);
      results.set(rowNumber, { row: rowNumber, name: row.name, status: "created" });
    }
  }

  for (const [rowNumber, row] of pending) {
    results.set(rowNumber, {
      row: rowNumber,
      name: row.name,
      status: "failed",
      message: row.parentPath
        ? `Parent path "${row.parentPath}" was not found. Make sure it already exists or appears earlier in the file.`
        : "Could not resolve this row.",
    });
  }

  const orderedResults = rows.map((row) => results.get(row.row)!);
  const summary = orderedResults.reduce(
    (acc, result) => {
      acc[result.status] += 1;
      return acc;
    },
    { created: 0, skipped: 0, failed: 0 }
  );

  if (!dryRun && summary.created > 0) {
    await logActivity({
      user: actorId,
      action: "NODE_CREATED",
      module: "FMS_CONFIG",
      description: `Bulk imported ${summary.created} organization node(s)${
        context.fileName ? ` from "${context.fileName}"` : ""
      } (${summary.skipped} skipped, ${summary.failed} failed).`,
      entityType: "OrganizationNode",
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  }

  return {
    dryRun,
    summary: { total: rows.length, ...summary },
    rows: orderedResults,
  };
}
