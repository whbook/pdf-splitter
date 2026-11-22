//! 章节范围校验。界面侧的 `src/lib/validate.ts` 必须使用同一套规则。

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::naming::{
    chapter_filename, char_len, normalize_unit, sanitize_component, split_directory_name,
    title_preview, truncate_chars, MAX_PATH_CHARS, MAX_TITLE_CHARS,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChapterRecord {
    pub id: String,
    pub start_page: Option<u32>,
    pub end_page: Option<u32>,
    pub title: String,
    pub manual_order: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub message: String,
    pub record_id: Option<String>,
    pub page: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedFile {
    pub record_id: String,
    pub sequence: u32,
    pub label: String,
    pub filename: String,
    pub start_page: u32,
    pub end_page: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Validation {
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
    pub files: Vec<PlannedFile>,
    pub directory_name: String,
}

pub fn is_blank(record: &ChapterRecord) -> bool {
    record.start_page.is_none() && record.end_page.is_none() && record.title.trim().is_empty()
}

pub fn sort_records(records: &[ChapterRecord]) -> Vec<ChapterRecord> {
    let mut sorted = records.to_vec();
    sorted.sort_by_key(|record| {
        (
            record.start_page.unwrap_or(u32::MAX),
            record.end_page.unwrap_or(u32::MAX),
            record.manual_order,
        )
    });
    sorted
}

pub fn validate(
    book_title: &str,
    output_dir: &str,
    page_count: u32,
    records: &[ChapterRecord],
    heading_unit: &str,
) -> Validation {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let book = sanitize_component(book_title);
    let directory_name = if book.is_empty() {
        String::new()
    } else {
        split_directory_name(&book)
    };

    if book_title.trim().is_empty() || book.is_empty() {
        errors.push(Issue {
            message: "书籍总名无效。请输入名称，不要只使用 \\ / : * ? \" < > | 这些字符。".into(),
            record_id: None,
            page: None,
        });
    }
    if output_dir.trim().is_empty() {
        errors.push(Issue {
            message: "请选择输出目录。".into(),
            record_id: None,
            page: None,
        });
    }
    let kept: Vec<ChapterRecord> = records.iter().filter(|record| !is_blank(record)).cloned().collect();
    if kept.is_empty() {
        errors.push(Issue {
            message: "请至少添加一个章节。".into(),
            record_id: None,
            page: None,
        });
    }

    let unit = normalize_unit(heading_unit).to_string();
    let sorted = sort_records(&kept);
    let mut usable: Vec<ChapterRecord> = Vec::new();

    for record in &sorted {
        let label = display_title(&record.title);
        match record.start_page {
            Some(page) if (1..=page_count).contains(&page) => {}
            Some(page) => errors.push(Issue {
                message: format!("「{label}」的起始页 {page} 不在 1–{page_count} 之内。"),
                record_id: Some(record.id.clone()),
                page: Some(page),
            }),
            None => errors.push(Issue {
                message: format!("「{label}」还没有填写起始页。"),
                record_id: Some(record.id.clone()),
                page: None,
            }),
        }
        match record.end_page {
            Some(page) if (1..=page_count).contains(&page) => {}
            Some(page) => errors.push(Issue {
                message: format!("「{label}」的结束页 {page} 不在 1–{page_count} 之内。"),
                record_id: Some(record.id.clone()),
                page: Some(page),
            }),
            None => errors.push(Issue {
                message: format!("「{label}」还没有填写结束页。"),
                record_id: Some(record.id.clone()),
                page: None,
            }),
        }
        if let (Some(start), Some(end)) = (record.start_page, record.end_page) {
            if start > end {
                errors.push(Issue {
                    message: format!("「{label}」的起始页 {start} 大于结束页 {end}。"),
                    record_id: Some(record.id.clone()),
                    page: Some(start),
                });
            } else if (1..=page_count).contains(&start) && (1..=page_count).contains(&end) {
                usable.push(record.clone());
            }
        }
        if unit.is_empty() && sanitize_component(&record.title).is_empty() {
            errors.push(Issue {
                message: format!("「{label}」没有可用的章节标题。"),
                record_id: Some(record.id.clone()),
                page: record.start_page,
            });
        }
    }

    let mut covered = vec![false; page_count as usize];
    for record in &usable {
        let start = record.start_page.unwrap();
        let end = record.end_page.unwrap();
        for page in start..=end {
            covered[(page - 1) as usize] = true;
        }
    }
    let missing = missing_segments(&covered);
    if page_count > 0 && !missing.is_empty() {
        errors.push(Issue {
            message: format!("{}没有归入任何章节。", format_segments(&missing)),
            record_id: None,
            page: Some(missing[0].0),
        });
    }

    reject_covering_earlier(&usable, &mut errors);
    warn_crowded_pages(&usable, &mut warnings);
    warn_duplicates(&usable, &mut warnings);

    let mut files = Vec::new();
    if !book.is_empty() && !output_dir.trim().is_empty() {
        let dir = Path::new(output_dir.trim()).join(&directory_name);
        let exportable: Vec<&ChapterRecord> = usable
            .iter()
            .filter(|record| !unit.is_empty() || !sanitize_component(&record.title).is_empty())
            .collect();
        let total = exportable.len();
        let mut used_names: Vec<(String, String)> = Vec::new();
        for record in &exportable {
            let sequence = files.len() as u32 + 1;
            let sanitized = sanitize_component(&record.title);
            let mut user_title = truncate_chars(&sanitized, MAX_TITLE_CHARS);
            let mut label = title_preview(&unit, sequence, total, &user_title);
            let mut filename = chapter_filename(&book, &label);
            loop {
                let full = dir.join(&filename);
                if char_len(&full.to_string_lossy()) <= MAX_PATH_CHARS {
                    break;
                }
                let len = char_len(&user_title);
                if len == 0 || (unit.is_empty() && len <= 1) {
                    errors.push(Issue {
                        message: "书籍总名或输出目录太长，完整路径放不下文件名。请缩短书籍总名，或换一个更浅的输出目录。"
                            .into(),
                        record_id: Some(record.id.clone()),
                        page: record.start_page,
                    });
                    user_title.clear();
                    break;
                }
                user_title = truncate_chars(&user_title, len - 1);
                label = title_preview(&unit, sequence, total, &user_title);
                filename = chapter_filename(&book, &label);
            }
            if char_len(&dir.join(&filename).to_string_lossy()) > MAX_PATH_CHARS {
                continue;
            }
            if unit.is_empty() && user_title.is_empty() {
                continue;
            }
            if let Some((_, other_id)) = used_names.iter().find(|(name, _)| name == &filename) {
                errors.push(Issue {
                    message: format!("整理后的文件名重复：{filename}。请修改章节标题。"),
                    record_id: Some(other_id.clone()),
                    page: None,
                });
                errors.push(Issue {
                    message: format!("整理后的文件名重复：{filename}。请修改章节标题。"),
                    record_id: Some(record.id.clone()),
                    page: None,
                });
            }
            used_names.push((filename.clone(), record.id.clone()));
            files.push(PlannedFile {
                record_id: record.id.clone(),
                sequence,
                label,
                filename,
                start_page: record.start_page.unwrap(),
                end_page: record.end_page.unwrap(),
            });
        }
    }

    Validation {
        errors,
        warnings,
        files,
        directory_name,
    }
}

fn display_title(title: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        "未命名章节".to_string()
    } else {
        trimmed.to_string()
    }
}

fn missing_segments(covered: &[bool]) -> Vec<(u32, u32)> {
    let mut segments = Vec::new();
    let mut index = 0;
    while index < covered.len() {
        if covered[index] {
            index += 1;
            continue;
        }
        let start = index;
        while index < covered.len() && !covered[index] {
            index += 1;
        }
        segments.push((start as u32 + 1, index as u32));
    }
    segments
}

fn format_segments(segments: &[(u32, u32)]) -> String {
    segments
        .iter()
        .map(|(start, end)| {
            if start == end {
                format!("第 {start} 页")
            } else {
                format!("第 {start}–{end} 页")
            }
        })
        .collect::<Vec<_>>()
        .join("、")
}

fn reject_covering_earlier(records: &[ChapterRecord], errors: &mut Vec<Issue>) {
    for pair in records.windows(2) {
        let (previous, next) = (&pair[0], &pair[1]);
        let (previous_start, previous_end) = (previous.start_page.unwrap(), previous.end_page.unwrap());
        let (next_start, next_end) = (next.start_page.unwrap(), next.end_page.unwrap());
        if next_start >= previous_end {
            continue;
        }
        errors.push(Issue {
            message: format!(
                "「{}」（{}）从第 {next_start} 页开始，盖住了前面的「{}」（{}）。后一条最多只能从前一条的结束页第 {previous_end} 页开始。",
                display_title(&next.title),
                format_segments(&[(next_start, next_end)]),
                display_title(&previous.title),
                format_segments(&[(previous_start, previous_end)]),
            ),
            record_id: Some(next.id.clone()),
            page: Some(next_start),
        });
    }
}

fn warn_crowded_pages(records: &[ChapterRecord], warnings: &mut Vec<Issue>) {
    let mut owners: BTreeMap<u32, Vec<&ChapterRecord>> = BTreeMap::new();
    for record in records {
        let start = record.start_page.unwrap();
        let end = record.end_page.unwrap();
        for page in start..=end {
            owners.entry(page).or_default().push(record);
        }
    }
    let crowded: Vec<(u32, Vec<&ChapterRecord>)> = owners.into_iter().filter(|(_, list)| list.len() >= 3).collect();
    let mut index = 0;
    while index < crowded.len() {
        let start_page = crowded[index].0;
        let group = &crowded[index].1;
        let key: Vec<&str> = group.iter().map(|record| record.id.as_str()).collect();
        let mut end_page = start_page;
        let mut cursor = index + 1;
        while cursor < crowded.len() {
            let page = crowded[cursor].0;
            let same_owners = crowded[cursor].1.iter().map(|record| record.id.as_str()).eq(key.iter().copied());
            if page != end_page + 1 || !same_owners {
                break;
            }
            end_page = page;
            cursor += 1;
        }
        let names = group
            .iter()
            .map(|record| format!("「{}」", display_title(&record.title)))
            .collect::<Vec<_>>()
            .join("");
        warnings.push(Issue {
            message: format!(
                "{}同时属于 {} 个章节：{names}。一页通常最多同时属于两个章节，请确认是不是标重了。",
                format_segments(&[(start_page, end_page)]),
                group.len(),
            ),
            record_id: group.last().map(|record| record.id.clone()),
            page: Some(start_page),
        });
        index = cursor;
    }
}

fn warn_duplicates(records: &[ChapterRecord], warnings: &mut Vec<Issue>) {
    for (index, record) in records.iter().enumerate() {
        let key = (
            record.start_page,
            record.end_page,
            record.title.trim().to_string(),
        );
        let seen = records.iter().take(index).any(|other| {
            (
                other.start_page,
                other.end_page,
                other.title.trim().to_string(),
            ) == key
        });
        let already_blocked = records
            .iter()
            .take(index)
            .any(|other| other.end_page.unwrap() > record.start_page.unwrap());
        if seen && !already_blocked {
            warnings.push(Issue {
                message: format!(
                    "「{}」（{}）添加了多次。",
                    display_title(&record.title),
                    format_segments(&[(record.start_page.unwrap(), record.end_page.unwrap())]),
                ),
                record_id: Some(record.id.clone()),
                page: record.start_page,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(book: &str, dir: &str, pages: u32, records: &[ChapterRecord]) -> Validation {
        validate(book, dir, pages, records, "")
    }

    fn chapter(order: u32, start: u32, end: u32, title: &str) -> ChapterRecord {
        ChapterRecord {
            id: format!("c{order}"),
            start_page: Some(start),
            end_page: Some(end),
            title: title.into(),
            manual_order: order,
        }
    }

    fn sample() -> Vec<ChapterRecord> {
        vec![
            chapter(1, 1, 4, "第一章"),
            chapter(2, 5, 5, "第二章"),
            chapter(3, 5, 6, "第三章"),
            chapter(4, 6, 7, "第四章"),
            chapter(5, 7, 7, "第五章"),
            chapter(6, 7, 7, "第六章"),
            chapter(7, 8, 20, "第七章"),
        ]
    }

    #[test]
    fn seven_chapters_cover_the_book_and_warn_about_page_seven() {
        let result = check("三国志", "D:\\书", 20, &sample());
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.warnings.len(), 1, "{:?}", result.warnings);
        assert!(result.warnings[0].message.contains("第 7 页同时属于 3 个章节"));
        let spans: Vec<u32> = result
            .files
            .iter()
            .map(|file| file.end_page - file.start_page + 1)
            .collect();
        assert_eq!(spans, vec![4, 1, 2, 2, 1, 1, 13]);
        assert_eq!(result.files[0].filename, "三国志-01-第一章.pdf");
        assert_eq!(result.files[0].label, "01-第一章");
        assert_eq!(result.files[6].filename, "三国志-07-第七章.pdf");
        assert_eq!(result.directory_name, "三国志-章节拆分");
    }

    #[test]
    fn reports_missing_pages_at_the_start_middle_and_end() {
        let start = check("书", "D:\\书", 20, &[chapter(1, 3, 20, "正文")]);
        assert!(start.errors.iter().any(|issue| issue.message.contains("第 1–2 页")));

        let middle = validate(
            "书",
            "D:\\书",
            20,
            &[chapter(1, 1, 4, "甲"), chapter(2, 6, 20, "乙")],
            "",
        );
        assert!(middle.errors.iter().any(|issue| issue.message.contains("第 5 页")));

        let end = check("书", "D:\\书", 20, &[chapter(1, 1, 18, "甲")]);
        assert!(end.errors.iter().any(|issue| issue.message.contains("第 19–20 页")));
    }

    #[test]
    fn rejects_reversed_pages_bounds_and_empty_titles() {
        let mut reversed = chapter(1, 7, 5, "倒序");
        reversed.end_page = Some(5);
        reversed.start_page = Some(7);
        let result = check("书", "D:\\书", 20, &[reversed]);
        assert!(result.errors.iter().any(|issue| issue.message.contains("大于结束页")));

        let result = check("书", "D:\\书", 20, &[chapter(1, 0, 21, "越界")]);
        assert!(result.errors.iter().any(|issue| issue.message.contains("起始页")));
        assert!(result.errors.iter().any(|issue| issue.message.contains("结束页")));

        let mut blank = chapter(1, 1, 20, "   ");
        blank.title = "   ".into();
        let result = check("书", "D:\\书", 20, &[blank]);
        assert!(result.errors.iter().any(|issue| issue.message.contains("标题")));

        let mut missing = chapter(1, 1, 20, "甲");
        missing.end_page = None;
        let result = check("书", "D:\\书", 20, &[missing]);
        assert!(result.errors.iter().any(|issue| issue.message.contains("结束页")));
    }

    #[test]
    fn rejects_a_later_range_that_starts_before_the_previous_end() {
        let overlap = validate(
            "书",
            "D:\\书",
            20,
            &[chapter(1, 5, 9, "第三章"), chapter(2, 6, 12, "第四章")],
            "",
        );
        assert!(overlap.errors.iter().any(|issue| issue.message.contains("没有归入任何章节")));
        assert!(overlap.errors.iter().any(|issue| issue.message.contains("从第 6 页开始") && issue.message.contains("结束页第 9 页")));
        assert!(!overlap.warnings.iter().any(|issue| issue.message.contains("盖住")));

        let contained = validate(
            "书",
            "D:\\书",
            20,
            &[chapter(1, 3, 15, "大章"), chapter(2, 6, 8, "小章")],
            "",
        );
        assert!(contained.errors.iter().any(|issue| {
            issue.message.contains("盖住了前面的") && issue.record_id.as_deref() == Some("c2")
        }));

        let boundary = check(
            "书",
            "D:\\书",
            5,
            &[chapter(1, 1, 3, "第一章"), chapter(2, 3, 5, "第二章")],
        );
        assert!(boundary.errors.is_empty(), "{:?}", boundary.errors);
        assert!(boundary.warnings.is_empty(), "{:?}", boundary.warnings);

        let too_early = check(
            "书",
            "D:\\书",
            5,
            &[chapter(1, 1, 3, "第一章"), chapter(2, 2, 5, "第二章")],
        );
        assert!(too_early.errors.iter().any(|issue| issue.message.contains("从第 2 页开始")));
    }

    #[test]
    fn warns_when_one_page_belongs_to_three_chapters_and_allows_two() {
        let three = check(
            "书",
            "D:\\书",
            1,
            &[chapter(1, 1, 1, "甲"), chapter(2, 1, 1, "乙"), chapter(3, 1, 1, "丙")],
        );
        assert!(three.errors.is_empty(), "{:?}", three.errors);
        assert!(three.warnings.iter().any(|issue| issue.message.contains("3 个章节")));

        let two = check("书", "D:\\书", 1, &[chapter(1, 1, 1, "甲"), chapter(2, 1, 1, "乙")]);
        assert!(two.errors.is_empty(), "{:?}", two.errors);
        assert!(two.warnings.is_empty(), "{:?}", two.warnings);
    }

    #[test]
    fn warns_about_a_duplicated_single_page() {
        let duplicated = validate(
            "书",
            "D:\\书",
            20,
            &[chapter(1, 7, 7, "第五章"), chapter(2, 7, 7, "第五章")],
            "",
        );
        assert!(duplicated.warnings.iter().any(|issue| issue.message.contains("添加了多次")));
    }

    #[test]
    fn sorts_by_start_then_end_then_manual_order() {
        let records = vec![
            chapter(2, 5, 6, "后写的宽范围"),
            chapter(3, 5, 5, "同页较晚"),
            chapter(1, 5, 5, "同页较早"),
        ];
        let result = check("书", "D:\\书", 6, &records);
        let names: Vec<&str> = result.files.iter().map(|file| file.filename.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "书-01-同页较早.pdf",
                "书-02-同页较晚.pdf",
                "书-03-后写的宽范围.pdf",
            ]
        );
    }

    #[test]
    fn truncates_long_titles_and_keeps_sanitized_names_distinct() {
        let long = "章".repeat(100);
        let result = check("书", "D:\\书", 1, &[chapter(1, 1, 1, &long)]);
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(char_len(result.files[0].label.strip_prefix("01-").unwrap()), 80);

        let result = check(
            "书",
            "D:\\书",
            2,
            &[chapter(1, 1, 1, "A/B"), chapter(2, 2, 2, "AB")],
        );
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.files[0].filename, "书-01-AB.pdf");
        assert_eq!(result.files[1].filename, "书-02-AB.pdf");
    }

    #[test]
    fn shrinks_the_title_until_the_path_fits() {
        let output = format!("D:\\{}", "目".repeat(180));
        let result = check("书", &output, 1, &[chapter(1, 1, 1, &"章".repeat(80))]);
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let title = result.files[0].label.split_once('-').unwrap().1;
        assert!(char_len(title) < 80);
        let full = std::path::Path::new(&output)
            .join(&result.directory_name)
            .join(&result.files[0].filename);
        assert!(char_len(&full.to_string_lossy()) <= MAX_PATH_CHARS);
    }

    #[test]
    fn heading_unit_replaces_the_sequence_and_title() {
        let chapters = [chapter(1, 1, 2, ""), chapter(2, 3, 4, "可留空")];
        let result = validate("三国志", "D:\\书", 4, &chapters, "章");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.files[0].label, "第1章");
        assert_eq!(result.files[1].label, "第2章-可留空");
        assert_eq!(result.files[0].filename, "三国志-第1章.pdf");
        assert_eq!(result.files[1].filename, "三国志-第2章-可留空.pdf");

        let essays = validate("三国志", "D:\\书", 4, &chapters, "篇");
        assert_eq!(essays.files[0].filename, "三国志-第1篇.pdf");
        assert_eq!(essays.files[1].filename, "三国志-第2篇-可留空.pdf");

        let ignored = validate("三国志", "D:\\书", 4, &[chapter(1, 1, 4, "正文")], "册");
        assert_eq!(ignored.files[0].filename, "三国志-01-正文.pdf");
    }

    #[test]
    fn ignores_a_blank_row_and_reports_a_partial_one() {
        let mut blank = chapter(2, 1, 1, "");
        blank.start_page = None;
        blank.end_page = None;
        blank.title.clear();
        let mut partial = chapter(3, 1, 1, "");
        partial.end_page = None;
        let result = check("书", "D:\\书", 2, &[chapter(1, 1, 2, "正文"), blank, partial]);
        assert!(result.files.iter().any(|file| file.filename == "书-01-正文.pdf"));
        assert!(result.errors.iter().any(|issue| issue.message.contains("结束页")));
        assert!(!result.errors.iter().any(|issue| issue.record_id.as_deref() == Some("c2")));
    }
}
