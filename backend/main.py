from __future__ import annotations

import hashlib
import io
import json
from datetime import datetime, timezone
from typing import Any

import yaml
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


app = FastAPI(title="Optibus Preference Comparison API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ReportRequest(BaseModel):
    previous_text: str
    updated_text: str
    previous_source: str = ""
    updated_source: str = ""


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/compare")
def compare_preferences(payload: ReportRequest) -> JSONResponse:
    report = build_report(payload)
    return JSONResponse(report)


@app.post("/api/report")
def create_report(payload: ReportRequest) -> Response:
    report = build_report(payload)
    pdf_bytes = build_pdf(report)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="optibus-preference-comparison-report.pdf"'},
    )


def build_report(payload: ReportRequest) -> dict[str, Any]:
    previous_data = parse_structured_text(payload.previous_text, "previous")
    updated_data = parse_structured_text(payload.updated_text, "updated")

    normalized_previous = normalize_for_diff(previous_data)
    normalized_updated = normalize_for_diff(updated_data)
    diff = diff_nodes(normalized_previous, normalized_updated)

    executive_summary = build_executive_summary(diff)
    return {
        "title": "Optibus Preference Comparison Report",
        "generated_at": now_iso(),
        "sources": {
            "previous": payload.previous_source,
            "updated": payload.updated_source,
        },
        "summary": {
            "added": len(diff["added"]),
            "removed": len(diff["removed"]),
            "changed": len(diff["changed"]),
        },
        "executive_summary": executive_summary,
        "sections": diff,
    }


def parse_structured_text(raw: str, label: str) -> Any:
    text = raw.strip()
    if not text:
        raise HTTPException(status_code=400, detail=f"The {label} input is empty.")

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        try:
            return yaml.safe_load(text)
        except yaml.YAMLError as exc:
            raise HTTPException(status_code=400, detail=f"The {label} input is not valid JSON or YAML: {exc}")


def normalize_for_diff(value: Any, path: str = "$") -> Any:
    if isinstance(value, list):
        keyed = create_keyed_object_if_possible(value, path)
        if keyed is not None:
            return normalize_for_diff(keyed, path)
        return sorted(
            [normalize_for_diff(item, f"{path}[{index}]") for index, item in enumerate(value)],
            key=stable_serialize,
        )

    if isinstance(value, dict):
        return {key: normalize_for_diff(value[key], f"{path}.{key}") for key in sorted(value.keys())}

    return value


def create_keyed_object_if_possible(items: list[Any], path: str) -> dict[str, Any] | None:
    if not items:
        return None

    outer_counts = count_outer_keys(items)
    keyed: dict[str, Any] = {}
    for index, item in enumerate(items):
        entry = to_comparable_entry(item, index, path, outer_counts)
        if entry is None:
            return None
        keyed[entry["key"]] = entry["value"]
    return keyed


def count_outer_keys(items: list[Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        if isinstance(item, dict) and len(item.keys()) == 1:
            outer = next(iter(item.keys()))
            counts[outer] = counts.get(outer, 0) + 1
    return counts


def to_comparable_entry(item: Any, index: int, path: str, outer_counts: dict[str, int]) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None

    keys = list(item.keys())
    if len(keys) == 1:
        outer = keys[0]
        payload = item[outer]
        if isinstance(payload, dict):
            qualifier = (
                payload.get("name")
                or payload.get("id")
                or payload.get("module_name")
                or payload.get("preference_folder_name")
                or payload.get("catalog")
                or payload.get("depot_name")
            )
            if qualifier:
                return {"key": f"{outer}::{qualifier}", "value": payload}
            if outer_counts.get(outer, 0) == 1:
                return {"key": outer, "value": payload}
            return {"key": f"{outer}::anon_{hash_text(stable_serialize(payload))}", "value": payload}

        if outer_counts.get(outer, 0) == 1:
            return {"key": outer, "value": payload}
        return {"key": f"{outer}::anon_{hash_text(stable_serialize(payload))}", "value": payload}

    qualifier = item.get("id") or item.get("name")
    if qualifier:
        prefix = "item" if "items" in path else "entry"
        return {"key": f"{prefix}::{qualifier}", "value": item}

    prefix = "item" if "items" in path else "entry"
    return {"key": f"{prefix}::anon_{hash_text(stable_serialize(item))}", "value": item}


def diff_nodes(before: Any, after: Any, path: str = "$") -> dict[str, list[dict[str, Any]]]:
    result = {"added": [], "removed": [], "changed": []}

    if before is None and after is not None and path != "$":
      result["added"].append(create_value_entry("added", path, after))
      return result
    if before is not None and after is None and path != "$":
      result["removed"].append(create_value_entry("removed", path, before))
      return result

    if is_primitive(before) or is_primitive(after):
        if before != after:
            result["changed"].append(
                {
                    "type": "changed",
                    "path": path,
                    "label": humanize_path(path),
                    "changes": [{"path": path, "before": before, "after": after}],
                }
            )
        return result

    if isinstance(before, list) or isinstance(after, list):
        if stable_serialize(before) != stable_serialize(after):
            result["changed"].append(
                {
                    "type": "changed",
                    "path": path,
                    "label": humanize_path(path),
                    "changes": [{"path": path, "before": before, "after": after}],
                }
            )
        return result

    before = before or {}
    after = after or {}
    for key in sorted(set(before.keys()) | set(after.keys())):
        child = diff_nodes(before.get(key), after.get(key), f"{path}.{key}")
        result["added"].extend(child["added"])
        result["removed"].extend(child["removed"])
        result["changed"].extend(child["changed"])

    return collapse_entries(result)


def collapse_entries(result: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    return {
        "added": merge_value_entries(result["added"]),
        "removed": merge_value_entries(result["removed"]),
        "changed": merge_changed_entries(result["changed"]),
    }


def merge_value_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for entry in entries:
        key = group_key(entry["path"])
        current = grouped.setdefault(
            key,
            {
                "type": entry["type"],
                "path": key,
                "label": humanize_path(key),
                "items": [],
            },
        )
        current["items"].append({"path": entry["path"], "value": entry["value"]})
    return sorted(grouped.values(), key=lambda item: item["label"])


def merge_changed_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for entry in entries:
        key = group_key(entry["path"])
        current = grouped.setdefault(
            key,
            {"type": "changed", "path": key, "label": humanize_path(key), "changes": []},
        )
        current["changes"].extend(entry["changes"])
    for value in grouped.values():
        value["changes"] = sorted(value["changes"], key=lambda item: item["path"])
    return sorted(grouped.values(), key=lambda item: item["label"])


def create_value_entry(kind: str, path: str, value: Any) -> dict[str, Any]:
    return {"type": kind, "path": path, "label": humanize_path(path), "value": value}


def group_key(path: str) -> str:
    parts = path.split(".")
    if len(parts) <= 2:
        return path
    if "::" in parts[1]:
        return ".".join(parts[:2])
    if len(parts) > 2 and "::" in parts[2]:
        return ".".join(parts[:3])
    return ".".join(parts[:2])


def humanize_path(path: str) -> str:
    if path == "$":
        return "Root"
    return " > ".join(humanize_token(part) for part in path.replace("$.", "").split("."))


def humanize_token(token: str) -> str:
    return token.replace("::", " / ").replace("_", " ").title()


def build_executive_summary(diff: dict[str, list[dict[str, Any]]]) -> list[str]:
    added = diff["added"]
    removed = diff["removed"]
    changed = diff["changed"]
    summary: list[str] = [
        f"Overall, {len(added)} preferences were added, {len(removed)} were removed, and {len(changed)} were updated."
    ]

    for entry in added:
        summary.append(describe_preference_entry(entry, "added"))
    for entry in removed:
        summary.append(describe_preference_entry(entry, "removed"))
    for entry in changed:
        top_changes = [interpret_change(change, entry["path"]) for change in entry["changes"][:3]]
        top_changes = [item for item in top_changes if item]
        if not top_changes:
            top_changes = [f"{humanize_path(entry['path'])} was updated."]
        summary.append(" ".join(top_changes))
    return summary


def describe_preference_entry(entry: dict[str, Any], kind: str) -> str:
    context = get_entry_context(entry["path"])
    value = entry["items"][0]["value"] if entry.get("items") else None
    action = "Added" if kind == "added" else "Removed"
    text = f"{action} {context['kind_label']}"
    if context["name"]:
        text += f' "{context["name"]}"'

    qualifiers: list[str] = []
    if isinstance(value, dict):
        if isinstance(value.get("enabled"), bool):
            qualifiers.append("enabled" if value["enabled"] else "disabled")
        if isinstance(value.get("pref_group_ids"), list) and value["pref_group_ids"]:
            qualifiers.append(f"applies to {join_list([str(item) for item in value['pref_group_ids']])}")
        parameter_summary = summarize_parameters(value.get("parameters"))
        if parameter_summary:
            qualifiers.append(parameter_summary)

    if qualifiers:
        text += ", " + ", ".join(qualifiers)
    return text + "."


def interpret_change(change: dict[str, Any], group_path: str) -> str:
    context = get_entry_context(group_path)
    leaf = get_readable_leaf(change["path"], group_path)
    before = summarize_value(change["before"])
    after = summarize_value(change["after"])

    if leaf == "Enabled" and isinstance(change["after"], bool):
        return f'{context["display"]} was {"enabled" if change["after"] else "disabled"}.'
    if ".pref_group_ids" in change["path"]:
        return f'{context["display"]} now applies to {join_list(normalize_array_summary(change["after"]))}.'
    if ".parameters." in change["path"] and leaf == "Value":
        parameter = get_parameter_name(change["path"])
        return f'{context["display"]} changed {parameter} from {before} to {after}.'
    if leaf == "Module Name":
        return f'{context["display"]} changed module from {before} to {after}.'
    if leaf == "Catalog":
        return f'{context["display"]} changed catalog from {before} to {after}.'
    return f"{leaf} changed from {before} to {after}."


def get_entry_context(path: str) -> dict[str, str]:
    cleaned = path.replace("$.", "")
    parts = cleaned.split(".")
    primary = parts[0] if parts else "preference"
    primary_human = humanize_token(primary.split("::")[0])
    named = next((part for part in parts if "::" in part), "")
    name = named.split("::", 1)[1] if named else ""
    kind_label = primary_human.lower()
    display = f'{primary_human} "{name}"' if name else primary_human
    return {"kind_label": kind_label, "name": name, "display": display}


def get_readable_leaf(path: str, group_path: str = "") -> str:
    cleaned = path.replace("$.", "")
    group_cleaned = group_path.replace("$.", "")
    suffix = cleaned[len(group_cleaned):].lstrip(".") if cleaned.startswith(group_cleaned) else cleaned
    if not suffix:
        return "This Preference"
    return humanize_token(suffix.split(".")[-1])


def summarize_parameters(parameters: Any) -> str:
    if not isinstance(parameters, dict):
        return ""
    bits: list[str] = []
    for key, value in parameters.items():
        if isinstance(value, dict) and "value" in value and len(bits) < 2:
            display_name = value.get("display_name") or key
            bits.append(f"{humanize_token(display_name)} {summarize_value(value.get('value'))}")
    return ", ".join(bits)


def summarize_value(value: Any) -> str:
    if value is None:
        return "empty"
    if isinstance(value, bool):
        return "enabled" if value else "disabled"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return f'"{value}"'
    if isinstance(value, list):
        if not value:
            return "none"
        if len(value) <= 3 and all(is_primitive(item) for item in value):
            return join_list([str(item) for item in value])
        return f"{len(value)} items"
    if isinstance(value, dict):
        if value.get("name"):
            return str(value["name"])
        if value.get("id"):
            return str(value["id"])
        return f"{len(value.keys())} settings"
    return str(value)


def normalize_array_summary(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    return [str(value)]


def get_parameter_name(path: str) -> str:
    marker = ".parameters."
    if marker not in path:
        return "the parameter"
    section = path.split(marker, 1)[1]
    return humanize_token(section.split(".")[0]).lower()


def join_list(values: list[str]) -> str:
    filtered = [value for value in values if value]
    if not filtered:
        return "no groups"
    if len(filtered) == 1:
        return filtered[0]
    if len(filtered) == 2:
        return f"{filtered[0]} and {filtered[1]}"
    return ", ".join(filtered[:-1]) + f", and {filtered[-1]}"


def is_primitive(value: Any) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def stable_serialize(value: Any) -> str:
    if is_primitive(value):
        return json.dumps(value, sort_keys=True)
    if isinstance(value, list):
        return "[" + ",".join(stable_serialize(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(f"{json.dumps(key)}:{stable_serialize(value[key])}" for key in sorted(value.keys())) + "}"
    return json.dumps(str(value))


def hash_text(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:10]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_pdf(report: dict[str, Any]) -> bytes:
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=18 * mm, bottomMargin=18 * mm)
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("Title", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=20, leading=24, textColor=colors.HexColor("#1f2430"), alignment=TA_LEFT, spaceAfter=8)
    subtitle_style = ParagraphStyle("Subtitle", parent=styles["BodyText"], fontName="Helvetica", fontSize=10, leading=14, textColor=colors.HexColor("#5e6573"), spaceAfter=14)
    section_style = ParagraphStyle("Section", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=14, leading=18, textColor=colors.HexColor("#0f766e"), spaceBefore=10, spaceAfter=8)
    body_style = ParagraphStyle("Body", parent=styles["BodyText"], fontName="Helvetica", fontSize=10, leading=14, textColor=colors.HexColor("#1f2430"), spaceAfter=6)

    story: list[Any] = []
    story.append(Paragraph(report["title"], title_style))
    story.append(
        Paragraph(
            f"Prepared {format_timestamp(report['generated_at'])}<br/>Previous source: {escape_pdf(report['sources'].get('previous') or 'Not provided')}<br/>Updated source: {escape_pdf(report['sources'].get('updated') or 'Not provided')}",
            subtitle_style,
        )
    )

    summary_table = Table(
        [
            ["Added Preferences", "Removed Preferences", "Updated Preferences"],
            [
                str(report["summary"]["added"]),
                str(report["summary"]["removed"]),
                str(report["summary"]["changed"]),
            ],
        ],
        colWidths=[55 * mm, 55 * mm, 55 * mm],
    )
    summary_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef6f5")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#0f766e")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTNAME", (0, 1), (-1, 1), "Helvetica-Bold"),
                ("FONTSIZE", (0, 1), (-1, 1), 16),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d8d2c4")),
                ("BACKGROUND", (0, 1), (-1, 1), colors.white),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    story.append(summary_table)
    story.append(Spacer(1, 10))

    story.append(Paragraph("Executive Summary", section_style))
    for line in report["executive_summary"]:
        story.append(Paragraph(f"• {escape_pdf(line)}", body_style))

    add_section_to_story(story, "Added Preferences", report["sections"]["added"], body_style, section_style)
    add_section_to_story(story, "Removed Preferences", report["sections"]["removed"], body_style, section_style)
    add_section_to_story(story, "Updated Preferences", report["sections"]["changed"], body_style, section_style)

    doc.build(story)
    return buffer.getvalue()


def add_section_to_story(story: list[Any], title: str, entries: list[dict[str, Any]], body_style: ParagraphStyle, section_style: ParagraphStyle) -> None:
    story.append(Paragraph(title, section_style))
    if not entries:
        story.append(Paragraph("No items in this section.", body_style))
        return
    for entry in entries:
        heading = escape_pdf(entry["label"])
        story.append(Paragraph(f"<b>{heading}</b>", body_style))
        if entry["type"] == "changed":
            lines = [interpret_change(change, entry["path"]) for change in entry["changes"][:6]]
        else:
            lines = describe_preference_lines(entry, entry["type"])
        for line in lines:
            story.append(Paragraph(f"• {escape_pdf(line)}", body_style))
        story.append(Spacer(1, 4))


def describe_preference_lines(entry: dict[str, Any], kind: str) -> list[str]:
    lines = [describe_preference_entry(entry, kind)]
    return lines


def format_timestamp(value: str) -> str:
    dt = datetime.fromisoformat(value)
    return dt.strftime("%d %b %Y %H:%M UTC")


def escape_pdf(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
