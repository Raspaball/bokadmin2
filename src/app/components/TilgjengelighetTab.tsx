import { useState, useEffect, useRef } from 'react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Loader2, Search, RefreshCw, CheckCircle2, AlertCircle, FileText, Upload, Pause, Plus, Trash2, Play, X } from 'lucide-react';
import { availabilityJobs, scheduledTasks, syncLog, type Job, type ScheduledTask, type SyncLogEntry } from '../utils/api';
import { toast } from 'sonner';

const CRON_PRESETS = [
  { label: 'Daglig kl 03:00', value: '0 3 * * *' },
  { label: 'Daglig kl 06:00', value: '0 6 * * *' },
  { label: 'Hver mandag kl 03:00', value: '0 3 * * 1' },
  { label: 'Hver 1. i maneden kl 03:00', value: '0 3 1 * *' },
  { label: 'Hver 6. time', value: '0 */6 * * *' },
  { label: 'Hver 12. time', value: '0 */12 * * *' },
];

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function TilgjengelighetTab() {
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [startMode, setStartMode] = useState<'analyze' | 'update' | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isResumingRef = useRef(false);

  const [recentJobs, setRecentJobs] = useState<Job[]>([]);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [jobLogEntries, setJobLogEntries] = useState<SyncLogEntry[]>([]);
  const [isLoadingJobLog, setIsLoadingJobLog] = useState(false);

  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [showAddTask, setShowAddTask] = useState(false);
  const [newTaskName, setNewTaskName] = useState('');
  const [newTaskCron, setNewTaskCron] = useState(CRON_PRESETS[0].value);
  const [newTaskMode, setNewTaskMode] = useState<'update' | 'analyze'>('update');

  useEffect(() => {
    checkActiveJob();
    loadRecentJobs();
    loadTasks();

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const checkActiveJob = async () => {
    try {
      const job = await availabilityJobs.getActive();
      if (job) {
        setActiveJob(job);
        startPolling(job.id);
      }
    } catch {
      // No active job
    }
  };

  const loadRecentJobs = async () => {
    try {
      const jobs = await availabilityJobs.getRecent(5);
      setRecentJobs(jobs);
    } catch {
      // ignore
    }
  };

  const loadTasks = async () => {
    try {
      const all = await scheduledTasks.getAll();
      setTasks(all.filter(t => t.type === 'availability_check'));
    } catch {
      // ignore
    }
  };

  const handleAddTask = async () => {
    if (!newTaskName.trim()) {
      toast.error('Gi oppgaven et navn');
      return;
    }
    try {
      await scheduledTasks.create({
        name: newTaskName,
        type: 'availability_check',
        cron_expr: newTaskCron,
        enabled: true,
        config: { mode: newTaskMode },
      });
      toast.success('Planlagt oppgave opprettet');
      setNewTaskName('');
      setShowAddTask(false);
      loadTasks();
    } catch (error) {
      toast.error('Kunne ikke opprette: ' + (error as Error).message);
    }
  };

  const handleToggleTask = async (task: ScheduledTask) => {
    try {
      await scheduledTasks.update(task.id, { enabled: !task.enabled });
      loadTasks();
    } catch (error) {
      toast.error('Kunne ikke oppdatere: ' + (error as Error).message);
    }
  };

  const handleDeleteTask = async (id: string) => {
    try {
      await scheduledTasks.delete(id);
      loadTasks();
    } catch (error) {
      toast.error('Kunne ikke slette: ' + (error as Error).message);
    }
  };

  const handleDeleteLogEntry = async (id: string) => {
    setJobLogEntries(prev => prev.filter(e => e.id !== id));
    try {
      await syncLog.deleteEntry(id);
    } catch (error) {
      toast.error('Kunne ikke slette: ' + (error as Error).message);
      if (expandedJobId) {
        const entries = await syncLog.getByJobId(expandedJobId).catch(() => []);
        setJobLogEntries(entries);
      }
    }
  };

  const toggleJobLog = async (jobId: string) => {
    if (expandedJobId === jobId) {
      setExpandedJobId(null);
      setJobLogEntries([]);
      return;
    }
    setExpandedJobId(jobId);
    setIsLoadingJobLog(true);
    try {
      const entries = await syncLog.getByJobId(jobId);
      setJobLogEntries(entries);
    } catch {
      toast.error('Kunne ikke hente logg');
    } finally {
      setIsLoadingJobLog(false);
    }
  };

  const startPolling = (jobId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const job = await availabilityJobs.getStatus(jobId);
        setActiveJob(job);

        if (job.status === 'paused' && !isResumingRef.current) {
          isResumingRef.current = true;
          try {
            await availabilityJobs.resume(jobId);
          } catch {
            // will retry on next poll
          } finally {
            setTimeout(() => { isResumingRef.current = false; }, 5000);
          }
        }

        if (job.status === 'completed' || job.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          loadRecentJobs();
          const mode = (job.config as { mode?: string })?.mode || 'analyze';
          if (job.status === 'completed') {
            if (mode === 'analyze') {
              toast.success(`Analyse fullfort: ${job.succeeded} avvik funnet, ${job.skipped} OK`);
            } else {
              toast.success(`Oppdatering fullfort: ${job.succeeded} endret, ${job.skipped} uendret`);
            }
          } else {
            toast.error('Tilgjengelighetssjekk feilet: ' + (job.error_message || 'Ukjent feil'));
          }
        }
      } catch {
        // ignore polling errors
      }
    }, 3000);
  };

  const handleCancel = async () => {
    if (!activeJob) return;
    try {
      await availabilityJobs.cancel(activeJob.id);
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      setActiveJob(null);
      loadRecentJobs();
      toast.info('Tilgjengelighetssjekk avbrutt');
    } catch (error) {
      toast.error('Kunne ikke avbryte: ' + (error as Error).message);
    }
  };

  const handleStart = async (mode: 'analyze' | 'update') => {
    setIsStarting(true);
    setStartMode(mode);
    try {
      const { jobId } = await availabilityJobs.start(mode);
      const job = await availabilityJobs.getStatus(jobId);
      setActiveJob(job);
      startPolling(jobId);
      toast.success(mode === 'analyze' ? 'Analyse startet' : 'Oppdatering startet');
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes('allerede')) {
        toast.info(msg);
        checkActiveJob();
      } else {
        toast.error('Kunne ikke starte: ' + msg);
      }
    } finally {
      setIsStarting(false);
      setStartMode(null);
    }
  };

  const isJobActive = activeJob && (activeJob.status === 'running' || activeJob.status === 'paused');
  const progress = activeJob && activeJob.total_items > 0
    ? Math.min(100, Math.round((activeJob.processed / activeJob.total_items) * 100))
    : 0;
  const activeMode = activeJob ? ((activeJob.config as { mode?: string })?.mode || 'analyze') : null;

  return (
    <>
      {/* Availability Check */}
      <Card>
        <CardHeader>
          <CardTitle>Tilgjengelighetssjekk</CardTitle>
          <CardDescription>
            Sjekker tilgjengelighet i Bokbasen og oppdaterer status, bok.tilgjengelighet og bok.utgivelsesdato i Shopify. Kommende og midlertidig utsolgte bøker er aktive og kan kjøpes
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isJobActive ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {activeJob.status === 'running' ? (
                    <Loader2 className="size-4 animate-spin text-blue-600" />
                  ) : (
                    <Pause className="size-4 text-yellow-600" />
                  )}
                  <span className="text-sm font-medium">
                    {activeMode === 'analyze' ? 'Analyserer' : 'Oppdaterer'}
                    {activeJob.status === 'running' ? '...' : ' (pauset)'}
                  </span>
                </div>
                <span className="text-sm text-gray-500">{progress}%</span>
              </div>

              <div className="bg-gray-200 rounded-full h-3">
                <div
                  className="bg-blue-600 rounded-full h-3 transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>

              <div className="text-sm text-gray-600 space-y-1">
                <p>
                  {activeJob.processed} bøker sjekket
                  {activeJob.current_isbn && (
                    <span className="text-gray-400 ml-2 font-mono text-xs">
                      (ISBN: {activeJob.current_isbn})
                    </span>
                  )}
                </p>
                <div className="flex gap-4 text-xs">
                  {activeJob.succeeded > 0 && (
                    <span className="text-yellow-600">
                      {activeJob.succeeded} {activeMode === 'analyze' ? 'avvik' : 'endret'}
                    </span>
                  )}
                  {activeJob.skipped > 0 && (
                    <span className="text-green-600">{activeJob.skipped} OK</span>
                  )}
                  {activeJob.failed > 0 && (
                    <span className="text-red-600">{activeJob.failed} feilet</span>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-400">
                  Du kan lukke denne fanen — sjekken fortsetter i bakgrunnen.
                </p>
                <Button variant="ghost" size="sm" onClick={handleCancel} className="text-red-500 hover:text-red-700">
                  <X className="size-4 mr-1" />
                  Avbryt
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={() => handleStart('analyze')}
                disabled={isStarting}
              >
                {isStarting && startMode === 'analyze' ? (
                  <Loader2 className="size-4 mr-2 animate-spin" />
                ) : (
                  <Search className="size-4 mr-2" />
                )}
                Kjor analyse
              </Button>
              <Button
                onClick={() => handleStart('update')}
                disabled={isStarting}
              >
                {isStarting && startMode === 'update' ? (
                  <Loader2 className="size-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="size-4 mr-2" />
                )}
                Oppdater Shopify
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Jobs */}
      {recentJobs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Siste sjekker</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentJobs
                .filter(j => j.status === 'completed' || j.status === 'failed')
                .slice(0, 5)
                .map(job => {
                  const mode = (job.config as { mode?: string })?.mode || 'analyze';
                  return (
                    <div key={job.id} className="rounded-lg border">
                      <div className="flex items-center gap-3 p-3">
                        {job.status === 'completed' ? (
                          <CheckCircle2 className="size-5 text-green-600 flex-shrink-0" />
                        ) : (
                          <AlertCircle className="size-5 text-red-600 flex-shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">
                            {mode === 'analyze' ? 'Analyse' : 'Oppdatering'}
                            {' — '}
                            {job.status === 'completed' ? 'Fullfort' : 'Feilet'}
                            {job.started_at && job.completed_at && (
                              <span className="text-gray-400 font-normal ml-2">
                                ({formatDuration(job.started_at, job.completed_at)})
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-gray-500">
                            {new Date(job.created_at).toLocaleString('nb-NO')}
                            {' — '}
                            {job.processed} sjekket, {job.succeeded} {mode === 'analyze' ? 'avvik' : 'endret'}, {job.skipped} OK
                            {job.failed > 0 && `, ${job.failed} feilet`}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => toggleJobLog(job.id)}
                        >
                          <FileText className="size-4 mr-1" />
                          {expandedJobId === job.id ? 'Skjul logg' : 'Vis logg'}
                        </Button>
                      </div>

                      {expandedJobId === job.id && (
                        <div className="border-t px-3 pb-3 pt-2">
                          {isLoadingJobLog ? (
                            <div className="flex items-center justify-center py-4">
                              <Loader2 className="size-4 animate-spin text-gray-400" />
                            </div>
                          ) : jobLogEntries.length === 0 ? (
                            <p className="text-sm text-gray-500 text-center py-3">Ingen loggoppforinger for denne jobben</p>
                          ) : (
                            <div className="divide-y max-h-[300px] overflow-y-auto">
                              {jobLogEntries.map((entry) => (
                                <div key={entry.id} className="py-2 text-sm flex items-start gap-2 group">
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      {entry.status === 'success' ? (
                                        <CheckCircle2 className="size-3 text-green-600 flex-shrink-0" />
                                      ) : (
                                        <AlertCircle className="size-3 text-red-600 flex-shrink-0" />
                                      )}
                                      <span className="font-mono text-xs text-gray-400">{entry.isbn}</span>
                                      <span className="truncate">{entry.title}</span>
                                    </div>
                                    <p className="text-xs text-gray-500 ml-5 mt-0.5">{entry.message}</p>
                                  </div>
                                  <button
                                    onClick={() => handleDeleteLogEntry(entry.id)}
                                    className="text-gray-400 hover:text-red-500 flex-shrink-0 mt-0.5 transition-colors"
                                  >
                                    <Trash2 className="size-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Planlagte tilgjengelighetsjobber */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Planlagte sjekker</CardTitle>
              <CardDescription>Sett opp automatiske tilgjengelighetsjobber</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowAddTask(!showAddTask)}>
              <Plus className="size-4 mr-1" />
              Legg til
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {showAddTask && (
            <div className="border rounded-lg p-4 space-y-3 bg-gray-50">
              <div>
                <label className="text-sm font-medium">Navn</label>
                <input
                  className="mt-1 w-full border rounded-md px-3 py-2 text-sm"
                  placeholder="F.eks. Daglig tilgjengelighetssjekk"
                  value={newTaskName}
                  onChange={e => setNewTaskName(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm font-medium">Intervall</label>
                <select
                  className="mt-1 w-full border rounded-md px-3 py-2 text-sm"
                  value={newTaskCron}
                  onChange={e => setNewTaskCron(e.target.value)}
                >
                  {CRON_PRESETS.map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm font-medium">Modus</label>
                <select
                  className="mt-1 w-full border rounded-md px-3 py-2 text-sm"
                  value={newTaskMode}
                  onChange={e => setNewTaskMode(e.target.value as 'update' | 'analyze')}
                >
                  <option value="update">Oppdater Shopify automatisk</option>
                  <option value="analyze">Kun analyse (ikke oppdater)</option>
                </select>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddTask}>Opprett</Button>
                <Button size="sm" variant="outline" onClick={() => setShowAddTask(false)}>Avbryt</Button>
              </div>
            </div>
          )}

          {tasks.length === 0 && !showAddTask && (
            <p className="text-sm text-gray-500 text-center py-4">
              Ingen planlagte sjekker. Klikk "Legg til" for a opprette en.
            </p>
          )}

          {tasks.length > 0 && (
            <div className="border rounded-lg divide-y">
              {tasks.map(task => (
                <div key={task.id} className="p-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => handleToggleTask(task)}
                      className={`size-8 rounded-full flex items-center justify-center transition-colors ${
                        task.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'
                      }`}
                    >
                      {task.enabled ? <Play className="size-3" /> : <Pause className="size-3" />}
                    </button>
                    <div>
                      <p className="text-sm font-medium">{task.name}</p>
                      <p className="text-xs text-gray-500">
                        {CRON_PRESETS.find(p => p.value === task.cron_expr)?.label || task.cron_expr}
                        {' · '}
                        {(task.config as { mode?: string })?.mode === 'analyze' ? 'Kun analyse' : 'Oppdater Shopify'}
                        {task.last_run_at && (
                          <span className="ml-2">
                            Siste: {new Date(task.last_run_at).toLocaleString('nb-NO')}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteTask(task.id)}
                  >
                    <Trash2 className="size-4 text-red-500" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* CSV Upload — mock placeholder */}
      <Card>
        <CardHeader>
          <CardTitle className="text-gray-400">CSV-opplasting</CardTitle>
          <CardDescription>Kommer snart — Last opp CSV med tilgjengelighetskoder</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" disabled className="w-full opacity-50">
            <Upload className="size-4 mr-2" />
            Velg fil
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
