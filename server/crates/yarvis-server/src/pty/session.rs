//! One PTY session, shared by any number of attached clients.
//!
//! Every byte the PTY produces gets a stream offset that counts every byte
//! ever produced, trimmed ones included. Appending to the scrollback and
//! handing the chunk to every subscriber happen under one lock, and so do a
//! client's snapshot and its subscription. A client's first live chunk
//! therefore starts exactly where its catch-up ended: no gap, no duplicate.
//!
//! Size follows the last active client: the first client to report a viewport
//! owns the size, and a client takes it over by typing or focusing. A
//! non-owner's viewport is recorded and applied once it takes over.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use portable_pty::{Child, ChildKiller, MasterPty, PtyPair, PtySize};
use serde::Serialize;
use tokio::sync::mpsc;

use super::SessionAgent;

const READ_BUF_SIZE: usize = 4096;

/// Input messages queued per session before a writer waits. Bounded so a
/// client pasting faster than the PTY drains waits on its own send, not on a
/// lock other clients need.
const INPUT_QUEUE: usize = 256;

/// How often the reader checks for the shell's exit status once the PTY has
/// closed. The status usually follows EOF within a millisecond or two.
const EXIT_POLL: Duration = Duration::from_millis(20);

/// How long an agent send waits for the session to take its input before it
/// gives up. Past this, whatever runs there isn't reading its terminal.
const INPUT_WAIT: Duration = Duration::from_secs(2);
const INPUT_RETRY: Duration = Duration::from_millis(5);
const NOT_ACCEPTING_INPUT: &str = "the session isn't accepting input";

/// The exit code reported when the shell's status couldn't be read.
pub const EXIT_UNKNOWN: u32 = u32::MAX;

fn exited() -> String {
    "the session has exited".to_string()
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Bytes of output kept per session for snapshots and resumes.
    pub scrollback_cap: usize,
    /// Events queued per client before it counts as lagging and is resynced
    /// from scrollback.
    pub client_queue: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Size {
    pub cols: u16,
    pub rows: u16,
}

impl Size {
    pub(crate) fn pty(self) -> PtySize {
        PtySize {
            rows: self.rows,
            cols: self.cols,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

#[derive(Clone, Debug)]
pub enum Event {
    Output { offset: u64, bytes: Bytes },
    Size { size: Size, owner: Option<u64> },
}

/// What a client gets when it attaches or is resynced.
pub struct Attach {
    pub rx: mpsc::Receiver<Event>,
    /// Set by the reader thread when it drops this subscription for being full.
    pub lagged: Arc<AtomicBool>,
    /// Where `catchup` starts in the stream.
    pub start_offset: u64,
    pub catchup: Vec<u8>,
    /// True when the client asked for an offset and got exactly that, so it can
    /// append. False means it must clear its screen and replay `catchup`.
    pub resumed: bool,
    /// Bytes between the requested offset and `start_offset` that are gone.
    pub lost_bytes: u64,
    pub size: Size,
    pub owner: Option<u64>,
    pub exit: Option<u32>,
}

struct Subscriber {
    tx: mpsc::Sender<Event>,
    lagged: Arc<AtomicBool>,
}

struct Inner {
    buf: VecDeque<u8>,
    /// Offset one past the last byte ever produced, trimmed bytes included.
    end_offset: u64,
    subs: HashMap<u64, Subscriber>,
    size: Size,
    /// The client whose viewport sets the PTY size.
    owner: Option<u64>,
    client_sizes: HashMap<u64, Size>,
    exit: Option<u32>,
}

impl Inner {
    /// Sends to every subscriber without blocking. A full queue drops that
    /// subscriber and flags it, so its task resyncs from scrollback instead of
    /// holding up the PTY or the other clients.
    fn broadcast(&mut self, ev: &Event) {
        self.subs.retain(|_, s| match s.tx.try_send(ev.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                s.lagged.store(true, Ordering::SeqCst);
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        });
    }

    fn buf_start(&self) -> u64 {
        self.end_offset - self.buf.len() as u64
    }

    /// Appends `chunk`, dropping the oldest bytes so the capture never exceeds
    /// `cap`, and returns the offset the chunk starts at. A `VecDeque` drops
    /// from the front without moving the rest, which a `Vec` would do on every
    /// read once the buffer is full.
    fn append(&mut self, chunk: &[u8], cap: usize) -> u64 {
        let start = self.end_offset;
        self.buf.extend(chunk);
        self.end_offset += chunk.len() as u64;
        if self.buf.len() > cap {
            let excess = self.buf.len() - cap;
            self.buf.drain(..excess);
        }
        start
    }
}

/// One write for the writer thread. `done`, when set, hears how it went, for
/// a caller that has to know the bytes reached the PTY before going on.
struct Input {
    data: Vec<u8>,
    done: Option<std::sync::mpsc::SyncSender<Result<(), String>>>,
}

pub struct Session {
    limits: Limits,
    inner: Mutex<Inner>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    shell_pid: Option<u32>,
    input: mpsc::Sender<Input>,
    /// Held by every write, and by an agent send from its text to its Enter,
    /// so a client typing during the pause can't land keys in the middle of
    /// the instruction or submit it early.
    input_gate: tokio::sync::Mutex<()>,
    agent: Option<SessionAgent>,
}

/// Takes a lock, recovering from poisoning rather than propagating: a reader
/// thread panic must not brick reattach, and the offsets only line up if every
/// capture is counted.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs on the reader thread once the shell has exited, with its code.
pub(crate) type OnExit = Box<dyn FnOnce(&Arc<Session>, u32) + Send>;

/// What [`Session::start`] needs besides the PTY itself.
pub(crate) struct Start {
    pub size: Size,
    /// See `SpawnSpec::start_offset`.
    pub start_offset: u64,
    pub initial_command: Option<String>,
    pub agent: Option<SessionAgent>,
    pub limits: Limits,
    pub on_exit: OnExit,
}

impl Session {
    /// Takes over a PTY whose child is already spawned, types the initial
    /// command, and starts the reader and writer threads.
    pub(crate) fn start(
        pair: PtyPair,
        child: Box<dyn Child + Send + Sync>,
        start: Start,
    ) -> Result<Arc<Session>, String> {
        // The parent doesn't need the slave once the child holds it. Closing
        // it lets the reader see EOF when the shell exits.
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        // The PTY buffers this until the shell is ready to read, and its echo
        // lands in the scrollback like any input.
        if let Some(command) = start.initial_command.as_deref() {
            let _ = writer.write_all(format!("{command}\r").as_bytes());
            let _ = writer.flush();
        }

        let (input_tx, mut input_rx) = mpsc::channel::<Input>(INPUT_QUEUE);
        let session = Arc::new(Session {
            limits: start.limits,
            inner: Mutex::new(Inner {
                buf: VecDeque::new(),
                end_offset: start.start_offset,
                subs: HashMap::new(),
                size: start.size,
                owner: None,
                client_sizes: HashMap::new(),
                exit: None,
            }),
            master: Mutex::new(pair.master),
            shell_pid: child.process_id(),
            killer: Mutex::new(child.clone_killer()),
            child: Mutex::new(child),
            input: input_tx,
            input_gate: tokio::sync::Mutex::new(()),
            agent: start.agent,
        });

        // PTY reads and writes block, so both live on OS threads rather than
        // the async runtime.
        std::thread::spawn(move || {
            while let Some(Input { data, done }) = input_rx.blocking_recv() {
                let result = writer
                    .write_all(&data)
                    .and_then(|()| writer.flush())
                    .map_err(|e| e.to_string());
                let failed = result.is_err();
                if let Some(done) = done {
                    let _ = done.send(result);
                }
                if failed {
                    break;
                }
            }
        });

        let reading = session.clone();
        let on_exit = start.on_exit;
        std::thread::spawn(move || {
            let mut buf = [0u8; READ_BUF_SIZE];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => reading.publish(&buf[..n]),
                }
            }
            let code = reading.wait_for_exit();
            reading.mark_exited(code);
            on_exit(&reading, code);
        });

        Ok(session)
    }

    fn publish(&self, data: &[u8]) {
        let mut g = lock(&self.inner);
        let offset = g.append(data, self.limits.scrollback_cap);
        g.broadcast(&Event::Output {
            offset,
            bytes: Bytes::copy_from_slice(data),
        });
    }

    /// The shell's exit code. Polled rather than waited on so `is_running`
    /// and the foreground checks can still take the child's lock meanwhile.
    fn wait_for_exit(&self) -> u32 {
        loop {
            match lock(&self.child).try_wait() {
                Ok(Some(status)) => return status.exit_code(),
                Ok(None) => {}
                Err(_) => return EXIT_UNKNOWN,
            }
            std::thread::sleep(EXIT_POLL);
        }
    }

    /// Dropping every sender closes each client's queue once it is drained,
    /// which is how client tasks learn the session ended after its last byte.
    fn mark_exited(&self, code: u32) {
        let mut g = lock(&self.inner);
        g.exit = Some(code);
        g.subs.clear();
    }

    /// Snapshots the scrollback from `from` (or from the oldest kept byte) and
    /// subscribes `client` to everything after it, atomically.
    pub fn subscribe(&self, client: u64, from: Option<u64>) -> Attach {
        let mut g = lock(&self.inner);
        let buf_start = g.buf_start();
        let end = g.end_offset;
        let (start, resumed, lost) = match from {
            Some(o) if o >= buf_start && o <= end => (o, true, 0),
            // Older than what's kept: the gap is lost, so send everything kept.
            Some(o) if o < buf_start => (buf_start, false, buf_start - o),
            // Past the end, such as an offset from a previous server run.
            Some(_) | None => (buf_start, false, 0),
        };
        let skip = (start - buf_start) as usize;
        let catchup: Vec<u8> = g.buf.range(skip..).copied().collect();
        let lagged = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel(self.limits.client_queue);
        if g.exit.is_none() {
            g.subs.insert(
                client,
                Subscriber {
                    tx,
                    lagged: lagged.clone(),
                },
            );
        }
        Attach {
            rx,
            lagged,
            start_offset: start,
            catchup,
            resumed,
            lost_bytes: lost,
            size: g.size,
            owner: g.owner,
            exit: g.exit,
        }
    }

    pub fn detach(&self, client: u64) {
        let mut g = lock(&self.inner);
        g.subs.remove(&client);
        g.client_sizes.remove(&client);
        if g.owner == Some(client) {
            // The PTY keeps its size; the next client to type or focus takes over.
            g.owner = None;
            let ev = Event::Size {
                size: g.size,
                owner: None,
            };
            g.broadcast(&ev);
        }
    }

    /// Records a client's viewport. It only changes the PTY when that client
    /// owns the size, or when nobody does yet.
    pub fn set_client_size(&self, client: u64, size: Size) {
        let mut g = lock(&self.inner);
        g.client_sizes.insert(client, size);
        if g.owner.is_none() || g.owner == Some(client) {
            g.owner = Some(client);
            self.apply_size(&mut g, size);
        }
    }

    /// Makes `client` the size owner: the last client to type or focus wins.
    pub fn claim(&self, client: u64) {
        let mut g = lock(&self.inner);
        if g.owner == Some(client) {
            return;
        }
        g.owner = Some(client);
        let size = g.client_sizes.get(&client).copied().unwrap_or(g.size);
        self.apply_size(&mut g, size);
    }

    /// Resizes the PTY for a caller that isn't an attached client
    /// (`pty_resize`). The owner stays as it was.
    pub fn resize(&self, size: Size) -> Result<(), String> {
        let mut g = lock(&self.inner);
        lock(&self.master)
            .resize(size.pty())
            .map_err(|e| e.to_string())?;
        g.size = size;
        let ev = Event::Size {
            size,
            owner: g.owner,
        };
        g.broadcast(&ev);
        Ok(())
    }

    fn apply_size(&self, g: &mut Inner, size: Size) {
        if size != g.size && lock(&self.master).resize(size.pty()).is_ok() {
            g.size = size;
        }
        let ev = Event::Size {
            size: g.size,
            owner: g.owner,
        };
        g.broadcast(&ev);
    }

    /// Queues input for the PTY. `client` is the attached client typing, which
    /// takes over the size; `None` for a caller with no viewport.
    pub async fn write(&self, client: Option<u64>, data: Vec<u8>) -> Result<(), String> {
        if let Some(client) = client {
            self.claim(client);
        }
        // Room in the queue first, then the gate: a writer waiting on a PTY
        // that has stopped reading must not hold the gate meanwhile, or an
        // agent send would wait behind it with every other client.
        let permit = self.input.reserve().await.map_err(|_| exited())?;
        let _gate = self.input_gate.lock().await;
        permit.send(Input { data, done: None });
        Ok(())
    }

    /// Holds the input gate from a blocking thread. See `input_gate`. Gives
    /// up after [`INPUT_WAIT`], since the sidecar's control requests wait on
    /// this.
    pub(crate) fn hold_input(&self) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
        let deadline = Instant::now() + INPUT_WAIT;
        loop {
            if let Ok(gate) = self.input_gate.try_lock() {
                return Ok(gate);
            }
            if Instant::now() > deadline {
                return Err(NOT_ACCEPTING_INPUT.into());
            }
            std::thread::sleep(INPUT_RETRY);
        }
    }

    /// Writes `data` and waits until it has reached the PTY, for at most
    /// [`INPUT_WAIT`]. Only for a caller already holding [`Self::hold_input`],
    /// from a blocking thread. Since the queue is first in, first out, this
    /// also waits for every write queued before it.
    pub(crate) fn write_and_wait(
        &self,
        _gate: &tokio::sync::MutexGuard<'_, ()>,
        data: &[u8],
    ) -> Result<(), String> {
        let deadline = Instant::now() + INPUT_WAIT;
        let (done, wait) = std::sync::mpsc::sync_channel(1);
        let mut input = Input {
            data: data.to_vec(),
            done: Some(done),
        };
        loop {
            match self.input.try_send(input) {
                Ok(()) => break,
                Err(mpsc::error::TrySendError::Closed(_)) => return Err(exited()),
                Err(mpsc::error::TrySendError::Full(back)) => {
                    if Instant::now() > deadline {
                        return Err(NOT_ACCEPTING_INPUT.into());
                    }
                    input = back;
                    std::thread::sleep(INPUT_RETRY);
                }
            }
        }
        match wait.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(result) => result,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(NOT_ACCEPTING_INPUT.into()),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(exited()),
        }
    }

    /// True while the session's shell is running.
    pub fn is_running(&self) -> bool {
        matches!(lock(&self.child).try_wait(), Ok(None))
    }

    pub fn shell_pid(&self) -> Option<u32> {
        self.shell_pid
    }

    /// The pid of the process group holding the PTY's foreground, when that is
    /// something other than the session's own shell. `None` when the shell
    /// itself is in the foreground, or when the platform can't report a
    /// process group.
    pub fn foreground_pid(&self) -> Option<u32> {
        #[cfg(unix)]
        {
            let fg = lock(&self.master).process_group_leader()?;
            let shell_pid = self.shell_pid?;
            (fg > 0 && (fg as u32) != shell_pid).then_some(fg as u32)
        }
        #[cfg(not(unix))]
        {
            None
        }
    }

    pub fn kill(&self) {
        let _ = lock(&self.killer).kill();
    }

    pub fn end_offset(&self) -> u64 {
        lock(&self.inner).end_offset
    }

    pub fn exit_code(&self) -> Option<u32> {
        lock(&self.inner).exit
    }

    pub fn agent(&self) -> Option<&SessionAgent> {
        self.agent.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inner(end_offset: u64) -> Inner {
        Inner {
            buf: VecDeque::new(),
            end_offset,
            subs: HashMap::new(),
            size: Size { cols: 80, rows: 24 },
            owner: None,
            client_sizes: HashMap::new(),
            exit: None,
        }
    }

    fn kept(g: &Inner) -> Vec<u8> {
        g.buf.iter().copied().collect()
    }

    #[test]
    fn append_leaves_under_cap_untouched() {
        let mut g = inner(0);
        g.append(b"hello", 1024);
        assert_eq!(kept(&g), b"hello");
    }

    #[test]
    fn append_trims_oldest_down_to_cap() {
        let mut g = inner(0);
        g.append(b"0123456789", 10);
        g.append(b"abcde", 10);
        assert_eq!(kept(&g), b"56789abcde");
    }

    #[test]
    fn append_handles_chunk_larger_than_cap() {
        let mut g = inner(0);
        g.append(b"abcdefghij", 4);
        assert_eq!(kept(&g), b"ghij");
    }

    #[test]
    fn append_real_cap_is_bounded() {
        let cap = super::super::MAX_SCROLLBACK;
        let mut g = inner(0);
        for _ in 0..512 {
            g.append(&[b'x'; 4096], cap);
        }
        assert!(g.buf.len() <= cap);
    }

    #[test]
    fn append_reports_the_offset_each_chunk_starts_at() {
        let mut g = inner(0);
        assert_eq!(g.append(b"hello", 1024), 0);
        assert_eq!(g.append(b" world", 1024), 5);
        assert_eq!(g.end_offset, 11);
    }

    #[test]
    fn append_keeps_counting_offsets_past_trimmed_bytes() {
        // The offsets are what a reattaching client resumes from, so trimming
        // the capture must not rewind them.
        let mut g = inner(0);
        g.append(b"0123456789", 4);
        assert_eq!(kept(&g), b"6789");
        assert_eq!(g.append(b"ab", 4), 10);
        assert_eq!(kept(&g), b"89ab");
        assert_eq!(g.end_offset, 12);
        assert_eq!(g.buf_start(), 8);
    }

    #[test]
    fn append_continues_from_a_carried_start_offset() {
        // A session replacing a dead one under the same id starts counting
        // where the dead one stopped, so a client's offset stays meaningful.
        let mut g = inner(50_000);
        assert_eq!(g.append(b"hi", 1024), 50_000);
        assert_eq!(kept(&g), b"hi");
        assert_eq!(g.end_offset, 50_002);
    }

    #[test]
    fn a_full_queue_drops_only_that_subscriber_and_flags_it() {
        let mut g = inner(0);
        let (slow_tx, _slow_rx) = mpsc::channel(1);
        let (fast_tx, mut fast_rx) = mpsc::channel(8);
        let slow_lagged = Arc::new(AtomicBool::new(false));
        g.subs.insert(
            1,
            Subscriber {
                tx: slow_tx,
                lagged: slow_lagged.clone(),
            },
        );
        g.subs.insert(
            2,
            Subscriber {
                tx: fast_tx,
                lagged: Arc::new(AtomicBool::new(false)),
            },
        );
        let ev = Event::Output {
            offset: 0,
            bytes: Bytes::from_static(b"x"),
        };
        g.broadcast(&ev);
        g.broadcast(&ev);
        assert!(slow_lagged.load(Ordering::SeqCst));
        assert!(!g.subs.contains_key(&1));
        assert!(g.subs.contains_key(&2));
        assert!(fast_rx.try_recv().is_ok() && fast_rx.try_recv().is_ok());
    }
}
