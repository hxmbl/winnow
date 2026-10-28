//! Which desktop notifications are up, so they can take themselves down.
//!
//! A new-mail notification should go when its message no longer needs attention: read,
//! archived, deleted, snoozed or moved, in Winnow or on Gmail anywhere (the web layer
//! sees it in the next sync and calls `notify_withdraw`). What "take it down" means
//! differs by desktop, so this module only keeps the books, as pure data that
//! `cargo test` checks on any host; `desktop.rs` (Linux, Windows) and `mod.rs` (macOS)
//! do the closing.
//!
//! - Per message: the OS's id for its notification (Linux's D-Bus id).
//! - Per account, the summary ("12 new messages" past the five): the OS id and the
//!   messages it counts. When those drop, the summary is re-shown with the new count
//!   under the same id (replaced in place, not a new alert), or closed when nothing it
//!   counts is left.
//! - macOS shows one notification per batch; it goes when every message in it has.

use std::collections::{HashMap, HashSet};

/// An account (`None`: a notification from before accounts) and a Gmail id.
pub type Key = (Option<String>, String);

#[derive(Debug, Clone, PartialEq)]
pub struct Summary {
    pub os_id: u32,
    /// Every message the summary counts, the ones with their own notification included.
    pub counted: HashSet<String>,
    /// The ones it counts that have no notification of their own.
    pub rest: HashSet<String>,
}

/// One batch shown as a single notification (macOS): its text, to find it again, and
/// the messages it stands for.
#[derive(Debug, Clone, PartialEq)]
pub struct Batch {
    pub account: Option<String>,
    pub title: String,
    pub body: String,
    pub ids: HashSet<String>,
}

/// What a dismissal asks the desktop to do.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Change {
    /// Message notifications to close, by OS id.
    pub close: Vec<u32>,
    /// A summary to close, by OS id.
    pub close_summary: Option<u32>,
    /// A summary to re-show in place: (OS id, how many it counts now, how many of those have no notification).
    pub update_summary: Option<(u32, usize, usize)>,
    /// macOS batches every message of which is gone: (title, body) of each.
    pub remove_batches: Vec<(String, String)>,
    /// Nothing of Winnow's is left up anywhere (Windows clears its Action Center entries).
    pub nothing_left: bool,
}

#[derive(Debug, Default)]
pub struct Ledger {
    messages: HashMap<Key, u32>,
    summaries: HashMap<Option<String>, Summary>,
    batches: Vec<Batch>,
}

impl Ledger {
    pub fn record_message(&mut self, account: Option<String>, gmail_id: String, os_id: u32) {
        self.messages.insert((account, gmail_id), os_id);
    }

    /// A summary went up for `account`, counting `shown` (with notifications) and `rest`.
    pub fn record_summary(
        &mut self,
        account: Option<String>,
        os_id: u32,
        shown: &[String],
        rest: &[String],
    ) {
        let mut counted: HashSet<String> = shown.iter().cloned().collect();
        counted.extend(rest.iter().cloned());
        // A second batch adds to what an earlier summary still counts.
        if let Some(old) = self.summaries.remove(&account) {
            counted.extend(old.counted);
        }
        let rest = rest.iter().cloned().collect();
        self.summaries.insert(
            account,
            Summary {
                os_id,
                counted,
                rest,
            },
        );
    }

    pub fn record_batch(&mut self, batch: Batch) {
        if !batch.ids.is_empty() {
            self.batches.push(batch);
        }
    }

    /// The notification with this OS id closed on its own (clicked, dismissed, expired).
    pub fn closed(&mut self, os_id: u32) {
        self.messages.retain(|_, id| *id != os_id);
        self.summaries.retain(|_, s| s.os_id != os_id);
    }

    pub fn summary(&self, account: &Option<String>) -> Option<&Summary> {
        self.summaries.get(account)
    }

    /// Messages whose notifications are up, for the web layer to check against its mail.
    pub fn active(&self) -> Vec<Key> {
        let mut keys: HashSet<Key> = self.messages.keys().cloned().collect();
        for (account, summary) in &self.summaries {
            for id in &summary.counted {
                keys.insert((account.clone(), id.clone()));
            }
        }
        for batch in &self.batches {
            for id in &batch.ids {
                keys.insert((batch.account.clone(), id.clone()));
            }
        }
        let mut list: Vec<Key> = keys.into_iter().collect();
        list.sort();
        list
    }

    fn is_empty(&self) -> bool {
        self.messages.is_empty() && self.summaries.is_empty() && self.batches.is_empty()
    }

    /// `gmail_ids` of `account` no longer need attention.
    pub fn dismiss(&mut self, account: &Option<String>, gmail_ids: &[String]) -> Change {
        let had_any = !self.is_empty();
        let mut change = Change::default();
        for id in gmail_ids {
            if let Some(os_id) = self.messages.remove(&(account.clone(), id.clone())) {
                change.close.push(os_id);
            }
        }
        if let Some(summary) = self.summaries.get_mut(account) {
            let before = summary.counted.len();
            for id in gmail_ids {
                summary.counted.remove(id);
                summary.rest.remove(id);
            }
            if summary.counted.len() != before {
                // A summary is there for the messages without a notification of their own;
                // with none of those left, the remaining notifications speak for themselves.
                if summary.rest.is_empty() || summary.counted.is_empty() {
                    change.close_summary = Some(summary.os_id);
                } else {
                    change.update_summary =
                        Some((summary.os_id, summary.counted.len(), summary.rest.len()));
                }
            }
        }
        if change.close_summary.is_some() {
            self.summaries.remove(account);
        }
        let mut kept = Vec::new();
        for mut batch in std::mem::take(&mut self.batches) {
            if &batch.account == account {
                for id in gmail_ids {
                    batch.ids.remove(id);
                }
            }
            if batch.ids.is_empty() {
                change.remove_batches.push((batch.title, batch.body));
            } else {
                kept.push(batch);
            }
        }
        self.batches = kept;
        change.nothing_left = had_any && self.is_empty();
        change
    }

    /// Signed out of `account` here: everything of it goes.
    pub fn clear_account(&mut self, account: &Option<String>) -> Change {
        let ids: Vec<String> = self
            .active()
            .into_iter()
            .filter(|(a, _)| a == account)
            .map(|(_, id)| id)
            .collect();
        let mut change = self.dismiss(account, &ids);
        if let Some(summary) = self.summaries.remove(account) {
            change.close_summary = Some(summary.os_id);
            change.update_summary = None;
        }
        change.nothing_left = self.is_empty();
        change
    }
}

/// A summary's text after a dismissal: the new count, and how many of them have no
/// notification of their own (the rest are on screen as their own notifications).
pub fn summary_text(counted: usize, rest: usize) -> (String, String) {
    let title = if counted == 1 {
        "1 new message".to_string()
    } else {
        format!("{counted} new messages")
    };
    let body = if rest == 1 {
        "1 more in Winnow".to_string()
    } else {
        format!("{rest} more in Winnow")
    };
    (title, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }
    fn acct() -> Option<String> {
        Some("abcd1234".into())
    }

    #[test]
    fn a_read_message_closes_its_own_notification_and_only_that_one() {
        let mut ledger = Ledger::default();
        ledger.record_message(acct(), "m1".into(), 11);
        ledger.record_message(acct(), "m2".into(), 12);
        ledger.record_message(Some("work9999".into()), "m1".into(), 13);
        let change = ledger.dismiss(&acct(), &ids(&["m1", "unknown"]));
        assert_eq!(change.close, vec![11]);
        assert!(!change.nothing_left);
        assert_eq!(ledger.active().len(), 2);
    }

    #[test]
    fn the_summary_count_follows_what_is_left_and_goes_with_its_last_extra() {
        let mut ledger = Ledger::default();
        let shown = ids(&["s1", "s2", "s3", "s4", "s5"]);
        for (i, id) in shown.iter().enumerate() {
            ledger.record_message(acct(), id.clone(), i as u32 + 1);
        }
        ledger.record_summary(acct(), 99, &shown, &ids(&["r1", "r2"]));
        let change = ledger.dismiss(&acct(), &ids(&["s1", "r1"]));
        assert_eq!(change.close, vec![1]);
        assert_eq!(change.update_summary, Some((99, 5, 1)));
        assert_eq!(
            summary_text(5, 1),
            ("5 new messages".to_string(), "1 more in Winnow".to_string())
        );
        let change = ledger.dismiss(&acct(), &ids(&["r2"]));
        assert_eq!(change.close_summary, Some(99));
        assert!(ledger.summary(&acct()).is_none());
    }

    #[test]
    fn a_mac_batch_goes_once_every_message_in_it_has() {
        let mut ledger = Ledger::default();
        ledger.record_batch(Batch {
            account: acct(),
            title: "3 new messages".into(),
            body: "Ada, Bob, Cy".into(),
            ids: ids(&["a", "b", "c"]).into_iter().collect(),
        });
        assert!(ledger
            .dismiss(&acct(), &ids(&["a", "b"]))
            .remove_batches
            .is_empty());
        let change = ledger.dismiss(&acct(), &ids(&["c"]));
        assert_eq!(
            change.remove_batches,
            vec![("3 new messages".to_string(), "Ada, Bob, Cy".to_string())]
        );
        assert!(change.nothing_left);
    }

    #[test]
    fn nothing_left_is_only_said_when_something_was_up() {
        let mut ledger = Ledger::default();
        assert!(!ledger.dismiss(&acct(), &ids(&["x"])).nothing_left);
        ledger.record_message(acct(), "m1".into(), 1);
        assert!(ledger.dismiss(&acct(), &ids(&["m1"])).nothing_left);
    }

    #[test]
    fn signing_out_clears_the_account_and_leaves_others() {
        let mut ledger = Ledger::default();
        ledger.record_message(acct(), "m1".into(), 1);
        ledger.record_summary(acct(), 50, &ids(&["m1"]), &ids(&["r1"]));
        ledger.record_message(Some("work9999".into()), "w1".into(), 2);
        let change = ledger.clear_account(&acct());
        assert_eq!(change.close, vec![1]);
        assert_eq!(change.close_summary, Some(50));
        assert_eq!(
            ledger.active(),
            vec![(Some("work9999".to_string()), "w1".to_string())]
        );
    }

    #[test]
    fn a_notification_that_closed_on_its_own_is_forgotten() {
        let mut ledger = Ledger::default();
        ledger.record_message(acct(), "m1".into(), 7);
        ledger.closed(7);
        assert!(ledger.active().is_empty());
        assert!(ledger.dismiss(&acct(), &ids(&["m1"])).close.is_empty());
    }
}
