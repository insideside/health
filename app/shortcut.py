"""Готовая команда iOS «Тренер: Здоровье» (.shortcut) — чтобы не собирать её руками.

Формат .shortcut не документирован: это plist со списком действий `WFWorkflowActions`, а связи между
действиями — по UUID (`OutputUUID`). Раскладка действий взята из команд, собранных в самом приложении
«Команды» и проверенных на телефоне:
Apple «Activity Report» из галереи, генераторы fcandi/Apple-Health-Sync и JarGad23/fitness-tracker,
справочник viticci/shortcuts-playground-plugin и декомпиляция ActionKit (WFFindHealthSamplesAction).

Команда ничего не считает сама: читает образцы и шлёт их серверу текстом, а сервер (health.py)
складывает, выбирает ночь сна и т. п. Так меньше действий, которые могут не так импортироваться.

Тренировки встроенными действиями «Команд» прочитать нельзя: «Найти образцы Здоровья» ищет только
количественные и категорийные данные (шаги, сон, пульс), а не HKWorkout. Поэтому их в команде нет.

iOS открывает только подписанные файлы: подпись делает `/usr/bin/shortcuts sign` — есть только на macOS.
"""
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import uuid

NAME = "Тренер: Здоровье"
OBJ = "￼"                      # место переменной внутри текста

# все идентификаторы действий, которые использует генератор (проверка в тестах)
ACTIONS = {
    "is.workflow.actions.format.date",
    "is.workflow.actions.filter.health.quantity",
    "is.workflow.actions.properties.health.quantity",
    "is.workflow.actions.repeat.each",
    "is.workflow.actions.gettext",
    "is.workflow.actions.downloadurl",
    "is.workflow.actions.notification",
}

CURRENT_DATE = {"Type": "CurrentDate"}
REPEAT_ITEM = {"Type": "Variable", "VariableName": "Repeat Item"}


class _Builder:
    def __init__(self, seed: str):
        self.actions: list[dict] = []
        self._ns = uuid.uuid5(uuid.NAMESPACE_URL, seed)   # детерминированные UUID: один и тот же файл на те же данные
        self._n = 0

    def uid(self) -> str:
        self._n += 1
        return str(uuid.uuid5(self._ns, str(self._n))).upper()

    def add(self, ident: str, params: dict, with_uuid: bool = True) -> str:
        u = self.uid()
        if with_uuid:
            params = {"UUID": u, **params}
        self.actions.append({"WFWorkflowActionIdentifier": ident, "WFWorkflowActionParameters": params})
        return u

    # ── значения параметров ──

    @staticmethod
    def out(uid: str, name: str, prop: str | None = None) -> dict:
        ref = {"OutputUUID": uid, "OutputName": name, "Type": "ActionOutput"}
        if prop:
            ref["Aggrandizements"] = [{"Type": "WFPropertyVariableAggrandizement", "PropertyName": prop}]
        return ref

    @staticmethod
    def attach(ref: dict) -> dict:
        return {"Value": ref, "WFSerializationType": "WFTextTokenAttachment"}

    @staticmethod
    def text(*parts) -> dict:
        """Текст с переменными: строки и ссылки вперемешку. Позиции — в UTF-16, как считает Foundation."""
        s, att = "", {}
        for p in parts:
            if isinstance(p, str):
                s += p
            else:
                att[f"{{{len(s.encode('utf-16-le')) // 2}, 1}}"] = p
                s += OBJ
        value = {"string": s}
        if att:
            value["attachmentsByRange"] = att
        return {"Value": value, "WFSerializationType": "WFTextTokenString"}

    def fields(self, pairs: list[tuple[str, dict]]) -> dict:
        return {"Value": {"WFDictionaryFieldValueItems": [
            {"WFItemType": 0, "WFKey": self.text(k), "WFValue": v} for k, v in pairs]},
            "WFSerializationType": "WFDictionaryFieldValue"}

    # ── действия ──

    def format_date(self, date_ref: dict, pattern: str) -> str:
        return self.add("is.workflow.actions.format.date", {
            "WFDateFormatStyle": "Custom", "WFDateFormat": pattern, "WFDate": self.text(date_ref)})

    def find(self, type_name: str, when: str, days: int = 1, unit: str | None = None,
             group_day: bool = False, latest: bool = False, oldest_first: bool = False) -> str:
        """«Найти образцы Здоровья»: тип (неудаляемая строка фильтра) + начальная дата сегодня / за N дней."""
        rows = [{"Property": "Type", "Operator": 4, "Removable": False, "Bounded": True,
                 "Values": {"Enumeration": {"Value": type_name, "WFSerializationType": "WFStringSubstitutableState"}}}]
        if when == "today":          # «Дата начала — сегодня»: так её сохраняет само приложение
            rows.append({"Property": "Start Date", "Operator": 1002, "Removable": False, "Bounded": True,
                         "Values": {"Unit": 16, "Number": 1, "Date": self.attach(CURRENT_DATE)}})
        else:                        # «за последние N дней» (Unit 16 = дни)
            rows.append({"Property": "Start Date", "Operator": 1001, "Removable": False, "Bounded": True,
                         "Values": {"Unit": 16, "Number": str(days)}})
        p = {"WFContentItemFilter": {"Value": {"WFActionParameterFilterPrefix": 1, "WFContentPredicateBoundedDate": False,
                                               "WFActionParameterFilterTemplates": rows},
                                     "WFSerializationType": "WFContentPredicateTableTemplate"}}
        if unit:
            p["WFHKSampleFilteringUnit"] = unit
        if group_day:                # итог за день без двойного счёта iPhone + Apple Watch
            p["WFHKSampleFilteringGroupBy"] = "Day"
            p["WFHKSampleFilteringFillMissing"] = False
        if latest or oldest_first:
            p["WFContentItemSortProperty"] = "Start Date"
            p["WFContentItemSortOrder"] = "Latest First" if latest else "Oldest First"
        if latest:
            p["WFContentItemLimitEnabled"] = True
            p["WFContentItemLimitNumber"] = 1.0
        return self.add("is.workflow.actions.filter.health.quantity", p)

    def detail(self, input_ref: dict, prop: str) -> str:
        """«Получить сведения об образцах Здоровья»: Значение / Дата начала / Дата окончания."""
        return self.add("is.workflow.actions.properties.health.quantity", {
            "WFContentItemPropertyName": prop, "WFInput": self.attach(input_ref)})


def build(url: str, token: str) -> bytes:
    """Неподписанный .shortcut (бинарный plist) с зашитыми адресом и токеном."""
    b = _Builder(f"{url}\n{token}")
    S = "Health Samples"

    today = b.format_date(CURRENT_DATE, "yyyy-MM-dd")

    steps_q = b.find("Steps", "today", unit="count", group_day=True)
    steps = b.detail(b.out(steps_q, S), "Value")

    kcal_q = b.find("Active Calories", "today", unit="kcal", group_day=True)
    kcal = b.detail(b.out(kcal_q, S), "Value")

    weight_q = b.find("Weight", "last", days=30, unit="kg", latest=True)
    weight = b.detail(b.out(weight_q, S), "Value")
    weight_start = b.detail(b.out(weight_q, S), "Start Date")
    weight_day = b.format_date(b.out(weight_start, "Start Date"), "yyyy-MM-dd")

    rhr_q = b.find("Resting Heart Rate", "last", days=2, unit="count/min", latest=True)
    rhr = b.detail(b.out(rhr_q, S), "Value")
    hrv_q = b.find("Heart Rate Variability", "last", days=2, unit="ms", latest=True)
    hrv = b.detail(b.out(hrv_q, S), "Value")

    # сон: каждая фаза строкой «начало;конец;фаза», ночь выбирает сервер
    sleep_q = b.find("Sleep", "last", days=2, oldest_first=True)
    group = b.uid()
    b.add("is.workflow.actions.repeat.each", {"GroupingIdentifier": group, "WFControlFlowMode": 0,
                                              "WFInput": b.attach(b.out(sleep_q, S))})
    fmt = "yyyy-MM-dd'T'HH:mm:ss"
    s_start = b.format_date(b.out(b.detail(REPEAT_ITEM, "Start Date"), "Start Date"), fmt)
    s_end = b.format_date(b.out(b.detail(REPEAT_ITEM, "End Date"), "End Date"), fmt)
    b.add("is.workflow.actions.gettext", {"WFTextActionText": b.text(
        b.out(s_start, "Formatted Date"), ";", b.out(s_end, "Formatted Date"), ";",
        {**REPEAT_ITEM, "Aggrandizements": [{"Type": "WFPropertyVariableAggrandizement", "PropertyName": "Value"}]})})
    sleep = b.add("is.workflow.actions.repeat.each", {"GroupingIdentifier": group, "WFControlFlowMode": 2})

    sep = "&" if "?" in url else "?"
    resp = b.add("is.workflow.actions.downloadurl", {
        "WFURL": f"{url}{sep}reply=text",
        "WFHTTPMethod": "POST",
        "ShowHeaders": True,
        "WFHTTPHeaders": b.fields([("X-Trainer-Token", b.text(token))]),
        "WFHTTPBodyType": "JSON",
        "WFJSONValues": b.fields([
            ("date", b.text(b.out(today, "Formatted Date"))),
            ("steps", b.text(b.out(steps, "Value"))),
            ("active_kcal", b.text(b.out(kcal, "Value"))),
            ("weight", b.text(b.out(weight, "Value"))),
            ("weight_date", b.text(b.out(weight_day, "Formatted Date"))),
            ("resting_hr", b.text(b.out(rhr, "Value"))),
            ("hrv", b.text(b.out(hrv, "Value"))),
            ("sleep", b.text(b.out(sleep, "Repeat Results"))),
            ("source", b.text("shortcut-1")),
        ]),
    })
    b.add("is.workflow.actions.notification", {
        "WFNotificationActionTitle": b.text("Тренер"),
        "WFNotificationActionBody": b.text(b.out(resp, "Contents of URL")),
        "WFNotificationActionSound": False,
    })

    wf = {
        "WFWorkflowName": NAME,
        "WFWorkflowClientVersion": "4610.1",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4282601983, "WFWorkflowIconGlyphNumber": 59754},  # красный, сердце
        "WFWorkflowTypes": [],
        "WFWorkflowInputContentItemClasses": [],
        "WFWorkflowOutputContentItemClasses": [],
        "WFWorkflowHasOutputFallback": False,
        "WFWorkflowHasShortcutInputVariables": False,
        "WFWorkflowImportQuestions": [],
        "WFQuickActionSurfaces": [],
        "WFWorkflowActions": b.actions,
    }
    return plistlib.dumps(wf, fmt=plistlib.FMT_BINARY)


SHORTCUTS = "/usr/bin/shortcuts"


def available() -> bool:
    """Подписать можно только на macOS с утилитой `shortcuts` (Monterey и новее)."""
    return sys.platform == "darwin" and os.path.exists(SHORTCUTS)


def sign(unsigned: bytes) -> bytes | None:
    """Подпись «для всех» (`--mode anyone`): файл откроется на любом iPhone. None — не вышло."""
    if not available():
        return None
    tmp = tempfile.mkdtemp(prefix="trainer-sc-")
    src, dst = os.path.join(tmp, "in.shortcut"), os.path.join(tmp, "out.shortcut")
    try:
        with open(src, "wb") as f:
            f.write(unsigned)
        r = subprocess.run([SHORTCUTS, "sign", "--mode", "anyone", "--input", src, "--output", dst],
                           capture_output=True, timeout=60)
        if r.returncode != 0 or not os.path.exists(dst):
            sign.last_error = (r.stderr or r.stdout or b"").decode("utf-8", "replace").strip()
            return None
        with open(dst, "rb") as f:
            data = f.read()
        return data or None
    except (OSError, subprocess.SubprocessError) as e:
        sign.last_error = str(e)
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


sign.last_error = ""
