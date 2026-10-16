import React, { useState } from 'react';
import { useLocation, Link } from 'wouter';
import { DashboardLayout } from '@/components/DashboardLayout';
import { usePatchworkStore } from '@/lib/patchworkStore';
import { useUser, useClerk } from '@clerk/clerk-react';
import {
  Settings,
  User,
  Building,
  Users,
  Github,
  Rocket,
  ExternalLink,
  ShieldCheck,
  Puzzle,
  Sparkles,
  CreditCard,
  CheckCircle2,
  AlertTriangle,
  Plus,
  Trash2,
  Key,
  Database,
  RefreshCw
} from 'lucide-react';

export default function SettingsPage() {
  const [location, setLocation] = useLocation();
  const clerk = useClerk();
  const { isSignedIn, user: clerkUser } = useUser();
  const {
    currentUser,
    workspace,
    members,
    integrations,
    updateIntegrations,
    extensionSessions,
    revokeExtensionSession,
    generatePairingCode,
    pairingCode,
  } = usePatchworkStore();

  const getInitialTab = (): 'workspace' | 'extension' | 'ai' | 'profile' | 'team' | 'security' | 'integrations' => {
    if (location.includes('/settings/extension')) return 'extension';
    if (location.includes('/settings/ai')) return 'ai';
    if (location.includes('/settings/team')) return 'team';
    if (location.includes('/settings/profile')) return 'profile';
    if (location.includes('/settings/security')) return 'security';
    if (location.includes('/settings/integrations')) return 'integrations';
    return 'workspace';
  };

  const [activeTab, setActiveTab] = useState<
    'integrations' | 'extension' | 'ai' | 'profile' | 'workspace' | 'team' | 'security'
  >(getInitialTab());

  // Integrations states
  const [githubSyncing, setGithubSyncing] = useState(false);
  const [vercelSyncing, setVercelSyncing] = useState(false);
  const [netlifySyncing, setNetlifySyncing] = useState(false);
  const [supabaseSyncing, setSupabaseSyncing] = useState(false);

  // Invite state
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('developer');
  const [invitedSuccess, setInvitedSuccess] = useState(false);

  // AI settings
  const [aiProvider, setAiProvider] = useState(integrations?.ai?.provider || 'gemini');
  const [aiModel, setAiModel] = useState(integrations?.ai?.model || 'gemini-1.5-pro');
  const [allowFrontend, setAllowFrontend] = useState(integrations?.ai?.allowFrontendModifications ?? true);
  const [allowBackend, setAllowBackend] = useState(integrations?.ai?.allowBackendModifications ?? false);
  const [requireHighRiskApproval, setRequireHighRiskApproval] = useState(integrations?.ai?.requireApprovalForHighRisk ?? true);

  const handleSyncGithub = () => {
    setGithubSyncing(true);
    setTimeout(() => {
      setGithubSyncing(false);
      updateIntegrations((p) => ({
        ...p,
        github: { ...p.github, lastSync: 'Just now' },
      }));
    }, 700);
  };

  const handleSyncVercel = () => {
    setVercelSyncing(true);
    setTimeout(() => {
      setVercelSyncing(false);
      updateIntegrations((p) => ({
        ...p,
        vercel: { ...p.vercel, lastSync: 'Just now' },
      }));
    }, 700);
  };

  const handleSyncNetlify = () => {
    setNetlifySyncing(true);
    setTimeout(() => {
      setNetlifySyncing(false);
      updateIntegrations((p) => ({
        ...p,
        netlify: { ...p.netlify, lastSync: 'Just now' },
      }));
    }, 700);
  };

  const handleSyncSupabase = () => {
    setSupabaseSyncing(true);
    setTimeout(() => {
      setSupabaseSyncing(false);
      updateIntegrations((p) => ({
        ...p,
        supabase: { ...p.supabase, lastSync: 'Just now' },
      }));
    }, 700);
  };

  const handleSaveAI = () => {
    updateIntegrations((p) => ({
      ...p,
      ai: {
        ...p.ai,
        provider: aiProvider as any,
        model: aiModel,
        allowFrontendModifications: allowFrontend,
        allowBackendModifications: allowBackend,
        requireApprovalForHighRisk: requireHighRiskApproval,
      },
    }));
  };

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail) return;
    setInvitedSuccess(true);
    setInviteEmail('');
    setTimeout(() => setInvitedSuccess(false), 3000);
  };

  return (
    <DashboardLayout
      title="Settings & Integrations"
      subtitle="Manage workspace authorization for GitHub, Vercel, Netlify, Supabase, Extension, and AI models."
    >
      <div className="space-y-6">
        {/* Settings Navigation Tabs */}
        <div className="flex items-center gap-2 overflow-x-auto pb-2 border-b border-black/10">
          {[
            { id: 'integrations', label: 'Integrations (GitHub / Vercel / Netlify / Supabase)', icon: Github },
            { id: 'extension', label: 'Chrome Extension', icon: Puzzle },
            { id: 'ai', label: 'AI Provider & Models', icon: Sparkles },
            { id: 'team', label: 'Team Members', icon: Users },
            { id: 'workspace', label: 'Workspace', icon: Building },
            { id: 'profile', label: 'Profile', icon: User },
            { id: 'security', label: 'Security & Access', icon: ShieldCheck },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold shrink-0 transition-all ${
                  isActive
                    ? 'bg-[#1B133C] text-white shadow-xs'
                    : 'bg-white/80 border border-black/5 text-[#1B133C]/70 hover:bg-white hover:text-[#1B133C]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* TAB 1: INTEGRATIONS */}
        {activeTab === 'integrations' && (
          <div className="space-y-6">
            <div className="p-4 rounded-xl bg-indigo-50 border border-indigo-200 text-xs text-indigo-900 flex items-center justify-between">
              <div>
                <p className="font-bold">Connected Integration Architecture</p>
                <p className="text-muted-foreground mt-0.5">
                  All sensitive provider credentials remain encrypted server-side and are never exposed to browser extensions.
                </p>
              </div>
              <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 font-semibold shrink-0">
                4 Providers Active ✓
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* GITHUB INTEGRATION */}
              <div className="glass-card p-6 border border-white/80 space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-black/5">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-black text-white flex items-center justify-center">
                      <Github className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="font-bold text-sm text-[#1B133C]">GitHub App</h4>
                      <p className="text-[11px] text-muted-foreground">Org: {integrations?.github?.org || 'axon-team'}</p>
                    </div>
                  </div>
                  <span className="px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-semibold">
                    Connected ✓
                  </span>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="flex justify-between text-muted-foreground">
                    <span>Installed Repositories:</span>
                    <strong className="text-[#1B133C]">{(integrations?.github?.repositories || []).length} repos</strong>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Permissions:</span>
                    <span className="font-mono text-[10px] text-indigo-700">Contents: Read/Write</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Last Sync:</span>
                    <span>{integrations?.github?.lastSync || 'Just now'}</span>
                  </div>
                </div>

                <div className="pt-2 flex justify-between items-center border-t border-black/5">
                  <button
                    onClick={handleSyncGithub}
                    disabled={githubSyncing}
                    className="text-xs text-indigo-600 font-semibold hover:underline flex items-center gap-1"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${githubSyncing ? 'animate-spin' : ''}`} />
                    <span>Sync Repositories</span>
                  </button>
                  <span className="text-[11px] text-emerald-700 font-semibold">Native App Installed</span>
                </div>
              </div>

              {/* VERCEL INTEGRATION */}
              <div className="glass-card p-6 border border-white/80 space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-black/5">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-black text-white flex items-center justify-center font-bold text-xs">
                      ▲
                    </div>
                    <div>
                      <h4 className="font-bold text-sm text-[#1B133C]">Vercel</h4>
                      <p className="text-[11px] text-muted-foreground">Team: {integrations?.vercel?.team || 'axon-prod'}</p>
                    </div>
                  </div>
                  <span className="px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-semibold">
                    Connected ✓
                  </span>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="flex justify-between text-muted-foreground">
                    <span>Linked Projects:</span>
                    <strong className="text-[#1B133C]">{(integrations?.vercel?.projects || []).join(', ') || 'axon-app'}</strong>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Domains:</span>
                    <strong className="text-[#1B133C]">{(integrations?.vercel?.domains || []).join(', ') || 'axon.dev'}</strong>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Last Sync:</span>
                    <span>{integrations?.vercel?.lastSync || 'Just now'}</span>
                  </div>
                </div>

                <div className="pt-2 flex justify-between items-center border-t border-black/5">
                  <button
                    onClick={handleSyncVercel}
                    disabled={vercelSyncing}
                    className="text-xs text-indigo-600 font-semibold hover:underline flex items-center gap-1"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${vercelSyncing ? 'animate-spin' : ''}`} />
                    <span>Sync Deployments</span>
                  </button>
                  <span className="text-[11px] text-emerald-700 font-semibold">Edge Previews Ready</span>
                </div>
              </div>

              {/* NETLIFY INTEGRATION */}
              <div className="glass-card p-6 border border-white/80 space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-black/5">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-teal-600 text-white flex items-center justify-center font-bold text-xs">
                      N
                    </div>
                    <div>
                      <h4 className="font-bold text-sm text-[#1B133C]">Netlify</h4>
                      <p className="text-[11px] text-muted-foreground">Team: {integrations?.netlify?.team || 'Not Configured'}</p>
                    </div>
                  </div>
                  <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${
                    integrations?.netlify?.connected ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'
                  }`}>
                    {integrations?.netlify?.connected ? 'Connected ✓' : 'Disconnected'}
                  </span>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="flex justify-between text-muted-foreground">
                    <span>Connected Sites:</span>
                    <strong className="text-[#1B133C]">{(integrations?.netlify?.sites || []).join(', ') || 'None'}</strong>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Adapter:</span>
                    <span className="font-mono text-[10px] text-teal-700">NetlifyDeployProvider</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Last Sync:</span>
                    <span>{integrations?.netlify?.lastSync || 'Not synced'}</span>
                  </div>
                </div>

                <div className="pt-2 flex justify-between items-center border-t border-black/5">
                  <button
                    onClick={handleSyncNetlify}
                    disabled={netlifySyncing}
                    className="text-xs text-indigo-600 font-semibold hover:underline flex items-center gap-1"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${netlifySyncing ? 'animate-spin' : ''}`} />
                    <span>Sync Sites</span>
                  </button>
                  <span className="text-[11px] text-emerald-700 font-semibold">Webhook Active</span>
                </div>
              </div>

              {/* SUPABASE INTEGRATION */}
              <div className="glass-card p-6 border border-white/80 space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-black/5">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center font-bold text-xs">
                      <Database className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="font-bold text-sm text-[#1B133C]">Supabase</h4>
                      <p className="text-[11px] text-muted-foreground font-mono">{integrations.supabase.projectUrl}</p>
                    </div>
                  </div>
                  <span className="px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-semibold">
                    Connected ✓
                  </span>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="flex justify-between text-muted-foreground">
                    <span>PostgreSQL & Auth:</span>
                    <strong className="text-emerald-700 font-bold">Enabled</strong>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Realtime WebSockets:</span>
                    <strong className="text-emerald-700 font-bold">Broadcasting</strong>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>Last Sync:</span>
                    <span>{integrations.supabase.lastSync}</span>
                  </div>
                </div>

                <div className="pt-2 flex justify-between items-center border-t border-black/5">
                  <button
                    onClick={handleSyncSupabase}
                    disabled={supabaseSyncing}
                    className="text-xs text-indigo-600 font-semibold hover:underline flex items-center gap-1"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${supabaseSyncing ? 'animate-spin' : ''}`} />
                    <span>Test Connection</span>
                  </button>
                  <span className="text-[11px] text-emerald-700 font-semibold">RLS Isolation Active</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: CHROME EXTENSION */}
        {activeTab === 'extension' && (
          <div className="space-y-6">
            <div className="glass-card p-6 border border-white/80 space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-black/5">
                <div>
                  <h3 className="text-base font-bold text-[#1B133C] flex items-center gap-2">
                    <Puzzle className="w-5 h-5 text-indigo-600" />
                    PATCHWORK Chrome Extension Client Pairing
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Connect your companion visual editor without sharing permanent workspace credentials.
                  </p>
                </div>
                <Link
                  href="/extension/connect"
                  className="px-4 py-2 rounded-xl bg-[#1B133C] text-white text-xs font-semibold hover:bg-black shadow-xs flex items-center gap-2"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Pair New Device</span>
                </Link>
              </div>

              {/* Active Sessions */}
              <div className="space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Active Paired Devices ({extensionSessions.length})
                </p>

                {extensionSessions.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-4 text-center">No Chrome extension sessions active.</p>
                ) : (
                  extensionSessions.map((sess) => (
                    <div
                      key={sess.id}
                      className="p-4 rounded-xl bg-white border border-black/5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-[#1B133C]">{sess.deviceName}</span>
                          <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-semibold">
                            Connected ✓
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Browser: {sess.browser} • Token Hash: <span className="font-mono">{sess.tokenHash}</span>
                        </p>
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {sess.permissions.map((perm) => (
                            <span key={perm} className="text-[10px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded">
                              ✓ {perm}
                            </span>
                          ))}
                        </div>
                      </div>

                      <button
                        onClick={() => revokeExtensionSession(sess.id)}
                        className="px-3 py-1.5 rounded-lg border border-rose-200 text-rose-700 bg-rose-50 hover:bg-rose-100 text-xs font-semibold transition-colors shrink-0"
                      >
                        Revoke Session
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: AI PROVIDER & MODELS */}
        {activeTab === 'ai' && (
          <div className="glass-card p-6 border border-white/80 space-y-6">
            <div className="flex items-center justify-between pb-3 border-b border-black/5">
              <div>
                <h3 className="text-base font-bold text-[#1B133C] flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-indigo-600" />
                  AI Model Configuration & Safety Gates
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  AI produces structured PatchPlans and never executes arbitrary production mutations without approval.
                </p>
              </div>
              <button
                onClick={handleSaveAI}
                className="px-4 py-2 rounded-xl bg-[#1B133C] text-white text-xs font-semibold hover:bg-black shadow-xs"
              >
                Save Settings
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
              <div className="space-y-4">
                <div>
                  <label className="block font-semibold text-[#1B133C] mb-1">AI Provider</label>
                  <select
                    value={aiProvider}
                    onChange={(e) => setAiProvider(e.target.value as any)}
                    className="w-full px-3 py-2 rounded-xl border border-black/10 bg-white text-xs font-medium"
                  >
                    <option value="gemini">Google Gemini (Recommended)</option>
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic Claude</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-[#1B133C] mb-1">Target Model</label>
                  <select
                    value={aiModel}
                    onChange={(e) => setAiModel(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-black/10 bg-white text-xs font-medium"
                  >
                    <option value="Gemini 2.5 Flash">Gemini 2.5 Flash (Fast visual reasoning)</option>
                    <option value="Gemini 2.5 Pro">Gemini 2.5 Pro (Deep AST synthesis)</option>
                    <option value="GPT-4o">OpenAI GPT-4o</option>
                    <option value="Claude 3.5 Sonnet">Claude 3.5 Sonnet</option>
                  </select>
                </div>
              </div>

              {/* Safety Toggles */}
              <div className="space-y-3">
                <span className="font-semibold text-[#1B133C] uppercase text-[10px] tracking-wider block">
                  Permissions & Approval Gates
                </span>

                <label className="flex items-center gap-3 p-3 rounded-xl bg-white border border-black/5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allowFrontend}
                    onChange={(e) => setAllowFrontend(e.target.checked)}
                    className="rounded text-indigo-600"
                  />
                  <div>
                    <p className="font-bold text-[#1B133C]">Allow AI Frontend Modifications</p>
                    <p className="text-[11px] text-muted-foreground">CSS, Tailwind classes, and JSX props</p>
                  </div>
                </label>

                <label className="flex items-center gap-3 p-3 rounded-xl bg-white border border-black/5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allowBackend}
                    onChange={(e) => setAllowBackend(e.target.checked)}
                    className="rounded text-indigo-600"
                  />
                  <div>
                    <p className="font-bold text-[#1B133C]">Allow AI Backend Modifications</p>
                    <p className="text-[11px] text-muted-foreground">API routes and database models (Disabled by default)</p>
                  </div>
                </label>

                <label className="flex items-center gap-3 p-3 rounded-xl bg-white border border-black/5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={requireHighRiskApproval}
                    onChange={(e) => setRequireHighRiskApproval(e.target.checked)}
                    className="rounded text-indigo-600"
                  />
                  <div>
                    <p className="font-bold text-[#1B133C]">Require 2-Person Sign-off for High Risk Patches</p>
                    <p className="text-[11px] text-muted-foreground">Blocks auto-merge when risk level exceeds threshold</p>
                  </div>
                </label>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: TEAM MEMBERS */}
        {activeTab === 'team' && (
          <div className="glass-card p-6 border border-white/80 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-black/5">
              <div>
                <h3 className="text-base font-bold text-[#1B133C] flex items-center gap-2">
                  <Users className="w-5 h-5 text-indigo-600" />
                  Team Roster & Roles
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Manage collaborators and invitation permissions.
                </p>
              </div>
            </div>

            {/* Invite Form */}
            <form onSubmit={handleInvite} className="p-4 rounded-xl bg-white border border-black/5 space-y-3">
              <span className="text-xs font-bold text-[#1B133C]">Invite Team Member</span>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="colleague@company.com"
                  className="flex-1 px-3 py-2 rounded-xl border border-black/10 bg-white text-xs"
                />
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="px-3 py-2 rounded-xl border border-black/10 bg-white text-xs font-medium"
                >
                  <option value="developer">Developer</option>
                  <option value="reviewer">Reviewer</option>
                  <option value="admin">Admin</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-[#1B133C] text-white text-xs font-semibold hover:bg-black"
                >
                  Send Invite
                </button>
              </div>
              {invitedSuccess && (
                <p className="text-xs text-emerald-600 font-medium">Invitation sent successfully!</p>
              )}
            </form>

            <div className="space-y-3">
              {members.map((m) => (
                <div key={m.id} className="p-3.5 rounded-xl bg-white border border-black/5 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <img
                      src={m.user.avatar}
                      alt={m.user.name}
                      className="w-9 h-9 rounded-full object-cover ring-1 ring-black/10"
                    />
                    <div>
                      <p className="text-xs font-bold text-[#1B133C]">{m.user.name}</p>
                      <p className="text-[11px] text-muted-foreground">{m.user.email}</p>
                    </div>
                  </div>
                  <span className="text-xs font-mono font-semibold px-2.5 py-1 rounded bg-black/5 text-[#1B133C] uppercase">
                    {m.role}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 5: WORKSPACE */}
        {activeTab === 'workspace' && (
          <div className="glass-card p-6 border border-white/80 space-y-4">
            <h3 className="text-base font-bold text-[#1B133C]">Workspace Overview</h3>
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div className="p-3 bg-white rounded-xl border border-black/5">
                <span className="text-muted-foreground">Workspace Name:</span>
                <p className="font-bold text-[#1B133C] mt-1">{workspace.name}</p>
              </div>
              <div className="p-3 bg-white rounded-xl border border-black/5">
                <span className="text-muted-foreground">Slug:</span>
                <p className="font-mono text-[#1B133C] mt-1">{workspace.slug}</p>
              </div>
              <div className="p-3 bg-white rounded-xl border border-black/5">
                <span className="text-muted-foreground">Plan:</span>
                <p className="font-bold text-indigo-700 mt-1">{workspace.plan} Tier</p>
              </div>
              <div className="p-3 bg-white rounded-xl border border-black/5">
                <span className="text-muted-foreground">Created:</span>
                <p className="text-[#1B133C] mt-1">{new Date(workspace.createdAt).toLocaleDateString()}</p>
              </div>
            </div>
          </div>
        )}

        {/* TAB 6: PROFILE */}
        {activeTab === 'profile' && (
          <div className="glass-card p-6 border border-white/80 space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-black/5">
              <div>
                <h3 className="text-base font-bold text-[#1B133C]">Profile Details</h3>
                <p className="text-xs text-muted-foreground">Authorized identity managed via Clerk SSO Authentication.</p>
              </div>
              {isSignedIn && (
                <button
                  onClick={() => clerk.openUserProfile?.()}
                  className="px-3.5 py-1.5 text-xs font-semibold rounded-xl bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 transition-all flex items-center gap-1.5 shadow-2xs"
                >
                  <User className="w-3.5 h-3.5" />
                  Manage Clerk Account
                </button>
              )}
            </div>

            <div className="flex items-center gap-4">
              <img
                src={
                  clerkUser?.imageUrl ||
                  currentUser?.avatar ||
                  `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(
                    clerkUser?.fullName || currentUser?.name || 'Axon User'
                  )}`
                }
                alt={clerkUser?.fullName || currentUser?.name}
                className="w-16 h-16 rounded-full object-cover ring-2 ring-indigo-200 shadow-xs"
              />
              <div className="space-y-1">
                <p className="text-base font-bold text-[#1B133C]">
                  {clerkUser?.fullName ||
                    [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(' ') ||
                    clerkUser?.username ||
                    currentUser?.name ||
                    'Axon User'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {clerkUser?.primaryEmailAddress?.emailAddress || currentUser?.email}
                </p>
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                    Clerk Authenticated ✓
                  </span>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    ID: {clerkUser?.id || currentUser?.id}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 7: SECURITY */}
        {activeTab === 'security' && (
          <div className="glass-card p-6 border border-white/80 space-y-4">
            <h3 className="text-base font-bold text-[#1B133C] flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-emerald-600" /> Security & Session Management
            </h3>
            <div className="space-y-3 text-xs">
              <div className="p-3 bg-white rounded-xl border border-black/5 flex justify-between items-center">
                <div>
                  <p className="font-bold text-[#1B133C]">Google OAuth Session</p>
                  <p className="text-muted-foreground">Single Sign-On (SSO) active</p>
                </div>
                <span className="text-emerald-700 font-semibold">Active ✓</span>
              </div>
              <div className="p-3 bg-white rounded-xl border border-black/5 flex justify-between items-center">
                <div>
                  <p className="font-bold text-[#1B133C]">Audit Log Immutability</p>
                  <p className="text-muted-foreground">All patch creations and rollbacks logged</p>
                </div>
                <span className="text-emerald-700 font-semibold">Enforced ✓</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
