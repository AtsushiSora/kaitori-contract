from io import BytesIO
import json
from pathlib import Path

import pypdfium2 as pdfium
from pypdf import PdfReader, PdfWriter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
CUSTOMER_TEMPLATE_PDF = ROOT / "templates" / "order_auto_blank_customer_template.pdf"
SHOP_TEMPLATE_PDF = ROOT / "templates" / "order_auto_blank_shop_template.pdf"
OUTPUT_DIR = ROOT / "output"
PREVIEW_DIR = ROOT / "previews"
INPUT_JSON = ROOT / "scripts" / "sample_contract_input.json"
OUTPUT_PDF = OUTPUT_DIR / "sample_contract_001.pdf"
OUTPUT_PREVIEW = PREVIEW_DIR / "sample_contract_001_preview.png"
SHOP_OUTPUT_PDF = OUTPUT_DIR / "sample_contract_001_shop.pdf"
SHOP_OUTPUT_PREVIEW = PREVIEW_DIR / "sample_contract_001_shop_preview.png"

PAGE_WIDTH = 595.2
PAGE_HEIGHT = 841.68


def ensure_dirs() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)


def y_from_preview(y_px: float) -> float:
    return PAGE_HEIGHT - (y_px / 2.0)


def x_from_preview(x_px: float) -> float:
    return x_px / 2.0


def draw_text(c: canvas.Canvas, x_px: float, y_px: float, text: str, size: float = 9.0) -> None:
    c.setFont("HeiseiKakuGo-W5", size)
    c.drawString(x_from_preview(x_px), y_from_preview(y_px), text)


def split_pdf_lines(value: str, max_chars: int = 64, max_lines: int = 2) -> list[str]:
    cleaned = " ".join(clean(value).split())
    if not cleaned:
        return []

    lines = []
    rest = cleaned
    while rest and len(lines) < max_lines:
        if len(rest) <= max_chars:
            lines.append(rest)
            rest = ""
            break
        lines.append(rest[:max_chars])
        rest = rest[max_chars:].strip()

    if rest and lines:
        lines[-1] = f"{lines[-1][:max(0, max_chars - 3)]}..."
    return lines


def draw_multiline_text(c: canvas.Canvas, x_px: float, y_px: float, text: str, size: float = 7.2, line_height_px: float = 15) -> None:
    lines = split_pdf_lines(text)
    adjusted_size = 6.7 if len(clean(text)) > 64 else size
    for index, line in enumerate(lines):
        draw_text(c, x_px, y_px + index * line_height_px, line, adjusted_size)


def draw_center(c: canvas.Canvas, x_px: float, y_px: float, text: str, size: float = 9.0) -> None:
    c.setFont("HeiseiKakuGo-W5", size)
    c.drawCentredString(x_from_preview(x_px), y_from_preview(y_px), text)


def draw_right(c: canvas.Canvas, x_px: float, y_px: float, text: str, size: float = 9.0) -> None:
    c.setFont("HeiseiKakuGo-W5", size)
    c.drawRightString(x_from_preview(x_px), y_from_preview(y_px), text)


def draw_white_rect(c: canvas.Canvas, x_px: float, y_px: float, width_px: float, height_px: float) -> None:
    c.saveState()
    c.setFillColorRGB(1, 1, 1)
    c.setStrokeColorRGB(1, 1, 1)
    c.rect(
        x_from_preview(x_px),
        y_from_preview(y_px + height_px),
        width_px / 2.0,
        height_px / 2.0,
        fill=1,
        stroke=0,
    )
    c.restoreState()


def draw_box(c: canvas.Canvas, x_px: float, y_px: float, width_px: float, height_px: float, line_width: float = 0.55) -> None:
    c.saveState()
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(line_width)
    c.rect(
        x_from_preview(x_px),
        y_from_preview(y_px + height_px),
        width_px / 2.0,
        height_px / 2.0,
        fill=0,
        stroke=1,
    )
    c.restoreState()


def draw_ellipse(c: canvas.Canvas, center_x_px: float, center_y_px: float, width_px: float = 15, height_px: float = 15) -> None:
    c.saveState()
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(0.65)
    radius = (width_px / 2.0) / 2.0
    c.circle(x_from_preview(center_x_px), y_from_preview(center_y_px), radius, stroke=1, fill=0)
    c.restoreState()


def draw_oval(c: canvas.Canvas, center_x_px: float, center_y_px: float, width_px: float, height_px: float) -> None:
    c.saveState()
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(0.65)
    x1 = x_from_preview(center_x_px - width_px / 2)
    x2 = x_from_preview(center_x_px + width_px / 2)
    y1 = y_from_preview(center_y_px + height_px / 2)
    y2 = y_from_preview(center_y_px - height_px / 2)
    c.ellipse(x1, y1, x2, y2, stroke=1, fill=0)
    c.restoreState()


def draw_line(c: canvas.Canvas, x1_px: float, y1_px: float, x2_px: float, y2_px: float, width: float = 0.55) -> None:
    c.saveState()
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(width)
    c.line(x_from_preview(x1_px), y_from_preview(y1_px), x_from_preview(x2_px), y_from_preview(y2_px))
    c.restoreState()


def draw_yes_no_circle(c: canvas.Canvas, value: str, no_x_px: float, yes_x_px: float, y_px: float) -> None:
    selected_x = yes_x_px if clean(value) == "有" else no_x_px
    draw_ellipse(c, selected_x, y_px, 19, 19)


def draw_identity_number_cells(c: canvas.Canvas, x_px: float, y_px: float, value: str) -> None:
    cell_width = 24
    digits = "".join(ch for ch in clean(value) if ch.isdigit())[:12]
    for index in range(12):
        draw_box(c, x_px + index * cell_width, y_px, cell_width, 30, 0.45)
    for index, digit in enumerate(digits):
        draw_center(c, x_px + index * cell_width + cell_width / 2, y_px + 22, digit, 7.2)


def draw_checkbox(c: canvas.Canvas, x_px: float, y_px: float, checked: bool = False) -> None:
    draw_box(c, x_px, y_px, 13, 13, 0.5)
    if not checked:
        return
    c.saveState()
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(0.7)
    c.line(x_from_preview(x_px + 2.5), y_from_preview(y_px + 7), x_from_preview(x_px + 5.5), y_from_preview(y_px + 10))
    c.line(x_from_preview(x_px + 5.5), y_from_preview(y_px + 10), x_from_preview(x_px + 11), y_from_preview(y_px + 3))
    c.restoreState()


def draw_identity_type_circle(c: canvas.Canvas, value: str) -> None:
    positions = {
        "運転免許証": (176, 1656, 68, 20),
        "パスポート": (255, 1659, 62, 20),
        "マイナンバー": (337, 1659, 78, 20),
        "マイナンバーカード": (337, 1659, 78, 20),
        "健康保険証": (423, 1659, 76, 20),
        "その他": (506, 1659, 70, 20),
    }
    selected = positions.get(clean(value))
    if selected:
        draw_oval(c, *selected)


def draw_shop_identity_footer(c: canvas.Canvas, sample: dict) -> None:
    y = 1600
    draw_spaced_chars(c, [296, 320, 344, 368, 392, 416, 440, 464, 488, 512, 536, 560], y + 24, sample["identity_number"], 7.2)
    draw_checkbox(c, 62, y + 17, sample["identity_confirmed"])
    draw_identity_type_circle(c, sample["identity_type"])
    draw_text(c, 1090, y + 24, sample["staff_signature_name"], 5.8)
    draw_text(c, 1090, y + 58, sample["manager_signature_name"], 5.8)


def draw_tax_status_circle(c: canvas.Canvas, value: str) -> None:
    positions = {
        "完納": (210, 523, 64, 27),
        "未納": (278, 523, 64, 27),
        "課税保留": (352, 523, 104, 27),
        "減免": (421, 523, 64, 27),
    }
    selected = positions.get(clean(value))
    if selected:
        draw_oval(c, *selected)


def draw_account_type_circle(c: canvas.Canvas, value: str) -> None:
    positions = {
        "普通": (524, 962),
        "当座": (524, 980),
        "その他": (524, 998),
    }
    selected = positions.get(clean(value))
    if selected:
        draw_ellipse(c, *selected, 13, 13)


def draw_owner_type_circle(c: canvas.Canvas, value: str) -> None:
    positions = {
        "売主": (186, 1134, 68, 20),
        "販売会社": (274, 1134, 78, 20),
        "信販会社": (368, 1134, 78, 20),
        "その他": (452, 1134, 64, 20),
    }
    selected = positions.get(clean(value) or "売主")
    if selected:
        draw_oval(c, *selected)


def draw_user_type_circle(c: canvas.Canvas, value: str) -> None:
    positions = {
        "売主": (186, 1166, 68, 20),
        "その他": (258, 1166, 64, 20),
    }
    selected = positions.get(clean(value) or "売主")
    if selected:
        draw_oval(c, *selected)


def time_text(value: str) -> str:
    cleaned = clean(value)
    if not cleaned:
        return ""
    parts = cleaned.split(":")
    if len(parts) != 2:
        return cleaned
    hour, minute = parts
    return str(int(hour))


def deadline_text(year: str, month: str, day: str, time_value: str) -> str:
    date_text = f"{year}年　{month}月　{day}日" if year or month or day else ""
    return " ".join(value for value in [date_text, time_text(time_value)] if value)


def draw_deadline_line(
    c: canvas.Canvas,
    rect_x_px: float,
    rect_y_px: float,
    rect_width_px: float,
    rect_height_px: float,
    text_x_px: float,
    text_y_px: float,
    year: str,
    month: str,
    day: str,
    time_value: str,
) -> None:
    text = deadline_text(year, month, day, time_value)
    if not text:
        return
    draw_white_rect(c, rect_x_px, rect_y_px, rect_width_px, rect_height_px)
    draw_text(c, text_x_px, text_y_px, text, 7.2)


def draw_spaced_chars(c: canvas.Canvas, x_positions_px: list[float], y_px: float, text: str, size: float = 9.0) -> None:
    c.setFont("HeiseiKakuGo-W5", size)
    chars = list(only_digits(text))[-len(x_positions_px):]
    chars = [""] * (len(x_positions_px) - len(chars)) + chars
    for x_px, char in zip(x_positions_px, chars):
        c.drawCentredString(x_from_preview(x_px), y_from_preview(y_px), char)


def draw_spaced_chars_without_ones(c: canvas.Canvas, x_positions_px: list[float], y_px: float, text: str, size: float = 9.0) -> None:
    digits = only_digits(text)
    if not digits:
        return
    draw_spaced_chars(c, x_positions_px, y_px, digits[:-1] or "0", size)


def draw_left_aligned_digits(c: canvas.Canvas, x_positions_px: list[float], y_px: float, text: str, size: float = 9.0) -> None:
    digits = only_digits(text)
    if not digits:
        return
    c.setFont("HeiseiKakuGo-W5", size)
    for x_px, char in zip(x_positions_px, digits[: len(x_positions_px)]):
        c.drawCentredString(x_from_preview(x_px), y_from_preview(y_px), char)


def clean(value) -> str:
    return str(value or "").strip()


def only_digits(value) -> str:
    return "".join(char for char in str(value or "") if char.isdigit())


def money_number(value) -> int:
    digits = only_digits(value)
    return int(digits) if digits else 0


def payment_amount(
    price: str,
    automobile_tax_status: str,
    automobile_tax_unpaid_amount: str,
    loan_status: str = "無",
    loan_balance_amount: str = "",
) -> str:
    unpaid_amount = money_number(automobile_tax_unpaid_amount) if clean(automobile_tax_status) == "未納" else 0
    loan_amount = money_number(loan_balance_amount) if clean(loan_status) == "有" else 0
    return str(max(money_number(price) - unpaid_amount - loan_amount, 0))


def join_values(*values) -> str:
    return " ".join(clean(value) for value in values if clean(value))


def date_parts(value) -> tuple[str, str, str]:
    cleaned = clean(value)
    if not cleaned:
        return "", "", ""
    parts = cleaned.replace("/", "-").split("-")
    if len(parts) != 3:
        return cleaned, "", ""
    year, month, day = parts
    return year, str(int(month)), str(int(day))


def normalize_input(data: dict) -> dict:
    contract_year, contract_month, contract_day = date_parts(data.get("contractDate"))
    delivery_year, delivery_month, delivery_day = date_parts(data.get("pickupDate"))
    document_year, document_month, document_day = date_parts(data.get("documentDeliveryDate"))
    payment_year, payment_month, payment_day = date_parts(data.get("paymentDate"))
    birth_year, birth_month, birth_day = date_parts(data.get("sellerBirthdate"))
    automobile_tax_status = clean(data.get("automobileTaxStatus") or "完納")
    automobile_tax_unpaid_amount = (
        clean(data.get("automobileTaxUnpaidAmount"))
        if automobile_tax_status == "未納"
        else "0"
    )
    loan_status = clean(data.get("loanStatus") or "無")
    loan_transfer_year, loan_transfer_month, loan_transfer_day = date_parts(data.get("loanTransferDate"))
    bank_transfer_status = clean(data.get("bankTransferStatus") or "無")
    price = clean(data.get("purchaseAmount") or data.get("price") or "0")

    return {
        "contract_no": clean(data.get("contractNumber") or data.get("contract_no") or "1"),
        "contract_year": contract_year,
        "contract_month": contract_month,
        "contract_day": contract_day,
        "car_name": clean(data.get("carName") or data.get("car_name")),
        "grade": clean(data.get("carGrade") or data.get("grade")),
        "model_year": clean(data.get("carYear") or data.get("model_year")),
        "color": clean(data.get("carColor") or data.get("color")),
        "chassis_no": clean(data.get("chassisNumber") or data.get("chassis_no")),
        "registration_no": clean(
            data.get("plateNumber")
            or join_values(
                data.get("plateArea"),
                data.get("plateClass"),
                data.get("plateKana"),
                data.get("plateNumberDigits"),
            ),
        ),
        "mileage": clean(data.get("mileage")),
        "engine_defect": clean(data.get("engineDefect") or "無"),
        "transmission_defect": clean(data.get("transmissionDefect") or "無"),
        "power_steering_defect": clean(data.get("powerSteeringDefect") or "無"),
        "suspension_defect": clean(data.get("suspensionDefect") or "無"),
        "driving_defect": clean(data.get("drivingDefect") or "無"),
        "parking_violation_unpaid": clean(data.get("parkingViolationUnpaid") or "無"),
        "repair_history": clean(data.get("repairHistory") or "無"),
        "meter_issue": clean(data.get("meterIssue") or "無"),
        "disaster_history": clean(data.get("disasterHistory") or "無"),
        "automobile_tax_status": automobile_tax_status,
        "automobile_tax_unpaid_amount": automobile_tax_unpaid_amount,
        "price": price,
        "payment_amount": payment_amount(
            price,
            automobile_tax_status,
            automobile_tax_unpaid_amount,
            loan_status,
            data.get("loanBalanceAmount"),
        ),
        "loan_status": loan_status,
        "loan_company": clean(data.get("loanCompany")) if loan_status == "有" else "",
        "loan_transfer_year": loan_transfer_year if loan_status == "有" else "",
        "loan_transfer_month": loan_transfer_month if loan_status == "有" else "",
        "loan_transfer_day": loan_transfer_day if loan_status == "有" else "",
        "loan_balance_amount": clean(data.get("loanBalanceAmount")) if loan_status == "有" else "",
        "delivery_year": delivery_year,
        "delivery_month": delivery_month,
        "delivery_day": delivery_day,
        "delivery_time": clean(data.get("pickupTime")),
        "document_year": document_year,
        "document_month": document_month,
        "document_day": document_day,
        "document_time": clean(data.get("documentDeliveryTime")),
        "payment_year": payment_year,
        "payment_month": payment_month,
        "payment_day": payment_day,
        "payment_time": clean(data.get("paymentTime")),
        "vehicle_note": clean(data.get("vehicleNote")),
        "bank_transfer_status": bank_transfer_status,
        "bank_name": clean(data.get("bankName")) if bank_transfer_status == "有" else "",
        "branch_name": clean(data.get("branchName")) if bank_transfer_status == "有" else "",
        "account_type": clean(data.get("accountType")) if bank_transfer_status == "有" else "",
        "account_number": clean(data.get("accountNumber")) if bank_transfer_status == "有" else "",
        "account_holder_kana": clean(data.get("accountHolderKana")) if bank_transfer_status == "有" else "",
        "account_holder": clean(data.get("accountHolder")) if bank_transfer_status == "有" else "",
        "owner_type": clean(data.get("ownerType") or "売主"),
        "owner_name": clean(data.get("ownerName")),
        "owner_relationship": clean(data.get("ownerRelationship")),
        "user_type": clean(data.get("userType") or "売主"),
        "user_name": clean(data.get("userName")),
        "user_relationship": clean(data.get("userRelationship")),
        "seller_kana": clean(
            data.get("sellerKana")
            or join_values(data.get("sellerLastKana"), data.get("sellerFirstKana")),
        ),
        "seller_name": clean(
            data.get("sellerName")
            or join_values(data.get("sellerLastName"), data.get("sellerFirstName")),
        ),
        "seller_postal": clean(data.get("sellerPostalCode") or data.get("sellerPostal") or data.get("seller_postal")),
        "seller_address": clean(data.get("sellerAddress") or data.get("seller_address")),
        "seller_home_phone": clean(data.get("sellerHomePhone") or data.get("sellerPhone") or data.get("seller_phone")),
        "seller_mobile": clean(data.get("sellerMobile") or data.get("seller_mobile")),
        "seller_workplace": clean(data.get("sellerWorkplace") or data.get("workplace")),
        "seller_workplace_phone": clean(data.get("sellerWorkplacePhone") or data.get("workplacePhone")),
        "identity_number": clean(data.get("identityNumber")),
        "identity_type": clean(data.get("identityType")),
        "identity_confirmed": bool(data.get("identityConfirmed") or data.get("identityType")),
        "staff_signature_name": clean(data.get("staffSignatureName")),
        "manager_signature_name": clean(data.get("managerSignatureName")),
        "seller_birth_year": birth_year,
        "seller_birth_month": birth_month,
        "seller_birth_day": birth_day,
    }


def load_sample() -> dict:
    with INPUT_JSON.open(encoding="utf-8") as f:
        return normalize_input(json.load(f))


def create_overlay_pdf(sample: dict, copy_type: str = "customer") -> BytesIO:
    packet = BytesIO()
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
    c = canvas.Canvas(packet, pagesize=(PAGE_WIDTH, PAGE_HEIGHT))
    c.setFillColorRGB(0, 0, 0)

    # Header.
    draw_right(c, 202, 72, sample["contract_year"], 8.5)
    draw_right(c, 282, 72, sample["contract_month"], 8.5)
    draw_right(c, 356, 72, sample["contract_day"], 8.5)
    draw_text(c, 1052, 70, sample["contract_no"], 10)

    # Vehicle details.
    draw_text(c, 180, 188, sample["car_name"], 10)
    draw_text(c, 180, 240, sample["grade"], 10)
    draw_text(c, 224, 290, sample["model_year"], 8.5)
    draw_text(c, 712, 188, sample["chassis_no"], 9)
    draw_text(c, 712, 240, sample["registration_no"], 9)
    draw_text(c, 712, 293, sample["color"], 9)
    draw_spaced_chars(c, [215, 252, 290, 328, 366, 404], 348, sample["mileage"], 9)
    draw_yes_no_circle(c, sample["engine_defect"], 614, 642, 320)
    draw_yes_no_circle(c, sample["transmission_defect"], 839, 869, 320)
    draw_yes_no_circle(c, sample["power_steering_defect"], 1084, 1110, 320)
    draw_yes_no_circle(c, sample["suspension_defect"], 647, 677, 338)
    draw_yes_no_circle(c, sample["driving_defect"], 812, 841, 338)
    draw_yes_no_circle(c, sample["parking_violation_unpaid"], 274, 304, 374)
    draw_yes_no_circle(c, sample["repair_history"], 432, 472, 374)
    draw_yes_no_circle(c, sample["meter_issue"], 782, 819, 375)
    draw_yes_no_circle(c, sample["disaster_history"], 1066, 1103, 375)

    # Price and deadlines.
    draw_spaced_chars(c, [161, 234, 307, 380, 453, 526, 593], 480, sample["price"], 13)
    draw_spaced_chars(c, [660, 733, 806, 879, 952, 1026, 1093], 762, sample["payment_amount"], 10)
    draw_tax_status_circle(c, sample["automobile_tax_status"])
    if clean(sample["automobile_tax_unpaid_amount"]) != "0":
        draw_spaced_chars_without_ones(c, [733, 806, 879, 953, 1026], 538, sample["automobile_tax_unpaid_amount"], 10)
    if sample["loan_status"] == "有":
        draw_text(c, 70, 598, sample["loan_company"], 7.8)
        draw_right(c, 372, 598, sample["loan_transfer_year"], 7.2)
        draw_right(c, 412, 598, sample["loan_transfer_month"], 7.2)
        draw_right(c, 454, 598, sample["loan_transfer_day"], 7.2)
        draw_spaced_chars(c, [660, 733, 806, 879, 952, 1026, 1093], 596, sample["loan_balance_amount"], 10)
    draw_deadline_line(
        c, 350, 812, 176, 24, 362, 832,
        sample["delivery_year"], sample["delivery_month"], sample["delivery_day"], sample["delivery_time"],
    )
    draw_deadline_line(
        c, 648, 812, 176, 24, 660, 832,
        sample["document_year"], sample["document_month"], sample["document_day"], sample["document_time"],
    )
    draw_deadline_line(
        c, 936, 812, 176, 24, 928, 832,
        sample["payment_year"], sample["payment_month"], sample["payment_day"], sample["payment_time"],
    )
    draw_multiline_text(c, 205, 878, sample["vehicle_note"])
    if sample["bank_transfer_status"] == "有":
        draw_center(c, 155, 988, sample["bank_name"], 7.4)
        draw_center(c, 395, 988, sample["branch_name"], 7.4)
        draw_account_type_circle(c, sample["account_type"])
        draw_left_aligned_digits(c, [604, 638, 672, 714, 748, 782, 816], 1000, sample["account_number"], 7.4)
        draw_center(c, 990, 982, sample["account_holder_kana"], 7.2)
        draw_center(c, 990, 1028, sample["account_holder"], 7.2)
    draw_owner_type_circle(c, sample["owner_type"])
    draw_text(c, 610, 1134, sample["owner_name"], 7.2)
    draw_text(c, 920, 1134, sample["owner_relationship"], 7.2)
    draw_user_type_circle(c, sample["user_type"])
    draw_text(c, 410, 1166, sample["user_name"], 7.2)
    draw_text(c, 920, 1166, sample["user_relationship"], 7.2)

    # Seller block.
    draw_text(c, 690, 1308, sample["seller_kana"], 8.0)
    draw_text(c, 690, 1338, sample["seller_name"], 9.5)
    draw_text(c, 704, 1396, sample["seller_postal"], 7.8)
    draw_text(c, 690, 1418, sample["seller_address"], 7.8)
    draw_line(c, 581, 1450, 1134, 1450)
    draw_text(c, 704, 1468, sample["seller_home_phone"], 7.6)
    draw_text(c, 704, 1488, sample["seller_mobile"], 7.6)
    draw_text(c, 850, 1506, sample["seller_birth_year"], 7.3)
    draw_text(c, 966, 1506, sample["seller_birth_month"], 7.3)
    draw_text(c, 1056, 1506, sample["seller_birth_day"], 7.3)
    draw_text(c, 690, 1546, sample["seller_workplace"], 7.5)
    draw_text(c, 704, 1568, sample["seller_workplace_phone"], 7.5)
    if copy_type == "shop":
        draw_shop_identity_footer(c, sample)

    c.save()
    packet.seek(0)
    return packet


def build_pdf(output_pdf: Path = OUTPUT_PDF, copy_type: str = "customer") -> None:
    template_pdf = SHOP_TEMPLATE_PDF if copy_type == "shop" else CUSTOMER_TEMPLATE_PDF
    base = PdfReader(str(template_pdf))
    overlay = PdfReader(create_overlay_pdf(load_sample(), copy_type))
    page = base.pages[0]
    page.merge_page(overlay.pages[0])
    writer = PdfWriter()
    writer.add_page(page)
    with output_pdf.open("wb") as f:
        writer.write(f)


def render_preview(input_pdf: Path = OUTPUT_PDF, output_preview: Path = OUTPUT_PREVIEW) -> None:
    pdf = pdfium.PdfDocument(str(input_pdf))
    page = pdf[0]
    bitmap = page.render(scale=2.0, rotation=0)
    bitmap.to_pil().save(output_preview)


if __name__ == "__main__":
    ensure_dirs()
    build_pdf(OUTPUT_PDF, "customer")
    render_preview(OUTPUT_PDF, OUTPUT_PREVIEW)
    build_pdf(SHOP_OUTPUT_PDF, "shop")
    render_preview(SHOP_OUTPUT_PDF, SHOP_OUTPUT_PREVIEW)
    print(OUTPUT_PDF)
    print(OUTPUT_PREVIEW)
    print(SHOP_OUTPUT_PDF)
    print(SHOP_OUTPUT_PREVIEW)
