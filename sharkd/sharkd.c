/* sharkd.c
 *
 * Daemon variant of Wireshark
 *
 * Wireshark - Network traffic analyzer
 * By Gerald Combs <gerald@wireshark.org>
 * Copyright 1998 Gerald Combs
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 */

#include <config.h>

#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>

#include <errno.h>

#ifndef _WIN32
#include <signal.h>
#endif

#ifdef HAVE_LIBCAP
# include <sys/capability.h>
#endif

#include <glib.h>

#include <epan/exceptions.h>
#include <epan/epan-int.h>
#include <epan/epan.h>

#include <wsutil/clopts_common.h>
#include <wsutil/cmdarg_err.h>
#include <wsutil/crash_info.h>
#include <wsutil/filesystem.h>
#include <wsutil/file_util.h>
#include <wsutil/privileges.h>
#include <wsutil/report_err.h>
#include <ws_version_info.h>
#include <wiretap/wtap_opttypes.h>
#include <wiretap/pcapng.h>

#include "globals.h"
#include <epan/timestamp.h>
#include <epan/packet.h>
#ifdef HAVE_LUA
#include <epan/wslua/init_wslua.h>
#endif
#include "frame_tvbuff.h"
#include <epan/disabled_protos.h>
#include <epan/prefs.h>
#include <epan/column.h>
#include <epan/print.h>
#include <epan/addr_resolv.h>
#ifdef HAVE_LIBPCAP
#include "ui/capture_ui_utils.h"
#endif
#include "ui/util.h"
#include "ui/ui_util.h"
#include "ui/decode_as_utils.h"
#include "ui/cli/tshark-tap.h"
#include "ui/tap_export_pdu.h"
#include "register.h"
#include "filter_files.h"
#include <epan/epan_dissect.h>
#include <epan/tap.h>
#include <epan/stat_tap_ui.h>
#include <epan/conversation_table.h>
#include <epan/srt_table.h>
#include <epan/rtd_table.h>
#include <epan/ex-opt.h>
#include <epan/exported_pdu.h>

#if defined(HAVE_HEIMDAL_KERBEROS) || defined(HAVE_MIT_KERBEROS)
#include <epan/asn1.h>
#include <epan/dissectors/packet-kerberos.h>
#endif

#include "capture_opts.h"

#include "caputils/capture-pcap-util.h"

#ifdef HAVE_LIBPCAP
#include "caputils/capture_ifinfo.h"
#ifdef _WIN32
#include "caputils/capture-wpcap.h"
#include <wsutil/os_version_info.h>
#include <wsutil/unicode-utils.h>
#endif /* _WIN32 */
#include <capchild/capture_session.h>
#include <capchild/capture_sync.h>
#include <capture_info.h>
#endif /* HAVE_LIBPCAP */
#include "log.h"
#include <epan/funnel.h>

#include <wsutil/str_util.h>
#include <wsutil/utf8_entities.h>

#ifdef HAVE_EXTCAP
#include "extcap.h"
#endif

#ifdef HAVE_PLUGINS
#include <wsutil/plugins.h>
#endif

/* sharkd_daemon.c */
extern int sharkd_init(int argc, char **argv);
extern int sharkd_loop(void);

#if 0
#define tshark_debug(...) g_warning(__VA_ARGS__)
#else
#define tshark_debug(...)
#endif

static guint32 cum_bytes;
static const frame_data *ref;
static frame_data ref_frame;
static frame_data *prev_dis;
static frame_data *prev_cap;

static gboolean do_dissection = TRUE; /* TRUE if we have to dissect each packet */
static gboolean print_packet_info; /* TRUE if we're to print packet information */
static gboolean really_quiet = FALSE;

#ifdef HAVE_LIBPCAP
/*
 * TRUE if we're to print packet counts to keep track of captured packets.
 */
static gboolean print_packet_counts;

static capture_options global_capture_opts;
static capture_session global_capture_session;

#ifdef SIGINFO
static gboolean infodelay;      /* if TRUE, don't print capture info in SIGINFO handler */
static gboolean infoprint;      /* if TRUE, print capture info after clearing infodelay */
#endif /* SIGINFO */

static void report_counts(void);
#ifdef _WIN32
#else /* _WIN32 */
#ifdef SIGINFO
static void report_counts_siginfo(int);
#endif /* SIGINFO */
#endif /* _WIN32 */

#else /* HAVE_LIBPCAP */

#endif /* HAVE_LIBPCAP */

static const char *cf_open_error_message(int err, gchar *err_info,
    gboolean for_writing, int file_type);

static void open_failure_message(const char *filename, int err,
    gboolean for_writing);
static void failure_message(const char *msg_format, va_list ap);
static void read_failure_message(const char *filename, int err);
static void write_failure_message(const char *filename, int err);
static void failure_message_cont(const char *msg_format, va_list ap);

capture_file cfile;

static void
tshark_log_handler (const gchar *log_domain, GLogLevelFlags log_level,
    const gchar *message, gpointer user_data)
{
  /* ignore log message, if log_level isn't interesting based
     upon the console log preferences.
     If the preferences haven't been loaded loaded yet, display the
     message anyway.

     The default console_log_level preference value is such that only
       ERROR, CRITICAL and WARNING level messages are processed;
       MESSAGE, INFO and DEBUG level messages are ignored.

     XXX: Aug 07, 2009: Prior tshark g_log code was hardwired to process only
           ERROR and CRITICAL level messages so the current code is a behavioral
           change.  The current behavior is the same as in Wireshark.
  */
  if ((log_level & G_LOG_LEVEL_MASK & prefs.console_log_level) == 0 &&
     prefs.console_log_level != 0) {
    return;
  }

  g_log_default_handler(log_domain, log_level, message, user_data);

}

static void
print_current_user(void) {
  gchar *cur_user, *cur_group;

  if (started_with_special_privs()) {
    cur_user = get_cur_username();
    cur_group = get_cur_groupname();
    fprintf(stderr, "Running as user \"%s\" and group \"%s\".",
      cur_user, cur_group);
    g_free(cur_user);
    g_free(cur_group);
    if (running_with_special_privs()) {
      fprintf(stderr, " This could be dangerous.");
    }
    fprintf(stderr, "\n");
  }
}

static void
get_tshark_compiled_version_info(GString *str)
{
  /* Capture libraries */
  get_compiled_caplibs_version(str);
}

static void
get_tshark_runtime_version_info(GString *str)
{
#ifdef HAVE_LIBPCAP
    /* Capture libraries */
    g_string_append(str, ", ");
    get_runtime_caplibs_version(str);
#endif

    /* stuff used by libwireshark */
    epan_get_runtime_version_info(str);
}

int
main(int argc, char *argv[])
{
  GString             *comp_info_str;
  GString             *runtime_info_str;
  char                *init_progfile_dir_error;

#ifdef _WIN32
  WSADATA              wsaData;
#endif  /* _WIN32 */

  char                *gpf_path, *pf_path;
  char                *gdp_path, *dp_path;
  char                *cf_path;
  char                *err_msg = NULL;
  int                  gpf_open_errno, gpf_read_errno;
  int                  pf_open_errno, pf_read_errno;
  int                  gdp_open_errno, gdp_read_errno;
  int                  dp_open_errno, dp_read_errno;
  int                  cf_open_errno;
  gboolean             quiet = FALSE;
  e_prefs             *prefs_p;
  int                  log_flags;

  tshark_debug("tshark started with %d args", argc);

  cmdarg_err_init(failure_message, failure_message_cont);

#ifdef _WIN32
  arg_list_utf_16to8(argc, argv);
  create_app_running_mutex();
#if !GLIB_CHECK_VERSION(2,31,0)
  g_thread_init(NULL);
#endif
#endif /* _WIN32 */

  /*
   * Get credential information for later use, and drop privileges
   * before doing anything else.
   * Let the user know if anything happened.
   */
  init_process_policies();
  relinquish_special_privs_perm();
  print_current_user();

  /*
   * Attempt to get the pathname of the executable file.
   */
  init_progfile_dir_error = init_progfile_dir(argv[0], main);
  if (init_progfile_dir_error != NULL) {
    fprintf(stderr, "tshark: Can't get pathname of tshark program: %s.\n",
            init_progfile_dir_error);
  }

  initialize_funnel_ops();

#ifdef _WIN32
  ws_init_dll_search_path();
  /* Load wpcap if possible. Do this before collecting the run-time version information */
  load_wpcap();

  /* Warn the user if npf.sys isn't loaded. */
  if (!npf_sys_is_running() && get_windows_major_version() >= 6) {
    fprintf(stderr, "The NPF driver isn't running.  You may have trouble "
      "capturing or\nlisting interfaces.\n");
  }
#endif

  /* Get the compile-time version information string */
  comp_info_str = get_compiled_version_info(get_tshark_compiled_version_info,
                                            epan_get_compiled_version_info);

  /* Get the run-time version information string */
  runtime_info_str = get_runtime_version_info(get_tshark_runtime_version_info);

  /* Add it to the information to be reported on a crash. */
  ws_add_crash_info("TShark (Wireshark) %s\n"
         "\n"
         "%s"
         "\n"
         "%s",
      get_ws_vcs_version_info(), comp_info_str->str, runtime_info_str->str);
  g_string_free(comp_info_str, TRUE);
  g_string_free(runtime_info_str, TRUE);

  /* Fail sometimes. Useful for testing fuzz scripts. */
  /* if (g_random_int_range(0, 100) < 5) abort(); */

  if (sharkd_init(argc, argv) < 0)
  {
    printf("cannot initialize shark daemon\n");
    return 1;
  }

/** Send All g_log messages to our own handler **/

  log_flags =
                    G_LOG_LEVEL_ERROR|
                    G_LOG_LEVEL_CRITICAL|
                    G_LOG_LEVEL_WARNING|
                    G_LOG_LEVEL_MESSAGE|
                    G_LOG_LEVEL_INFO|
                    G_LOG_LEVEL_DEBUG|
                    G_LOG_FLAG_FATAL|G_LOG_FLAG_RECURSION;

  g_log_set_handler(NULL,
                    (GLogLevelFlags)log_flags,
                    tshark_log_handler, NULL /* user_data */);
  g_log_set_handler(LOG_DOMAIN_MAIN,
                    (GLogLevelFlags)log_flags,
                    tshark_log_handler, NULL /* user_data */);

#ifdef HAVE_LIBPCAP
  g_log_set_handler(LOG_DOMAIN_CAPTURE,
                    (GLogLevelFlags)log_flags,
                    tshark_log_handler, NULL /* user_data */);
  g_log_set_handler(LOG_DOMAIN_CAPTURE_CHILD,
                    (GLogLevelFlags)log_flags,
                    tshark_log_handler, NULL /* user_data */);
#endif

  init_report_err(failure_message, open_failure_message, read_failure_message,
                  write_failure_message);

#ifdef HAVE_LIBPCAP
  capture_opts_init(&global_capture_opts);
  capture_session_init(&global_capture_session, &cfile);
#endif

  timestamp_set_type(TS_RELATIVE);
  timestamp_set_precision(TS_PREC_AUTO);
  timestamp_set_seconds_type(TS_SECONDS_DEFAULT);

  init_open_routines();

#ifdef HAVE_PLUGINS
  /* Register all the plugin types we have. */
  epan_register_plugin_types(); /* Types known to libwireshark */
  wtap_register_plugin_types(); /* Types known to libwiretap */

  /* Scan for plugins.  This does *not* call their registration routines;
     that's done later. */
  scan_plugins();

  /* Register all libwiretap plugin modules. */
  register_all_wiretap_modules();
#else
  wtap_opttypes_initialize();
#endif

  /* Register all dissectors; we must do this before checking for the
     "-G" flag, as the "-G" flag dumps information registered by the
     dissectors, and we must do it before we read the preferences, in
     case any dissectors register preferences. */
  if (!epan_init(register_all_protocols, register_all_protocol_handoffs, NULL,
                 NULL))
    return 2;

  /* Register all tap listeners; we do this before we parse the arguments,
     as the "-z" argument can specify a registered tap. */

  /* we register the plugin taps before the other taps because
     stats_tree taps plugins will be registered as tap listeners
     by stats_tree_stat.c and need to registered before that */
#ifdef HAVE_PLUGINS
  register_all_plugin_tap_listeners();
#endif
  register_all_tap_listeners();
  conversation_table_set_gui_info(init_iousers);
  hostlist_table_set_gui_info(init_hostlists);
  srt_table_iterate_tables(register_srt_tables, NULL);
  rtd_table_iterate_tables(register_rtd_tables, NULL);
  new_stat_tap_iterate_tables(register_simple_stat_tables, NULL);

  /* load the decode as entries of this profile */
  load_decode_as_entries();

  tshark_debug("tshark reading preferences");

  prefs_p = read_prefs(&gpf_open_errno, &gpf_read_errno, &gpf_path,
                     &pf_open_errno, &pf_read_errno, &pf_path);
  if (gpf_path != NULL) {
    if (gpf_open_errno != 0) {
      cmdarg_err("Can't open global preferences file \"%s\": %s.",
              pf_path, g_strerror(gpf_open_errno));
    }
    if (gpf_read_errno != 0) {
      cmdarg_err("I/O error reading global preferences file \"%s\": %s.",
              pf_path, g_strerror(gpf_read_errno));
    }
  }
  if (pf_path != NULL) {
    if (pf_open_errno != 0) {
      cmdarg_err("Can't open your preferences file \"%s\": %s.", pf_path,
              g_strerror(pf_open_errno));
    }
    if (pf_read_errno != 0) {
      cmdarg_err("I/O error reading your preferences file \"%s\": %s.",
              pf_path, g_strerror(pf_read_errno));
    }
    g_free(pf_path);
    pf_path = NULL;
  }

  read_filter_list(CFILTER_LIST, &cf_path, &cf_open_errno);
  if (cf_path != NULL) {
      cmdarg_err("Could not open your capture filter file\n\"%s\": %s.",
          cf_path, g_strerror(cf_open_errno));
      g_free(cf_path);
  }

  if (!color_filters_init(&err_msg, NULL)) {
     fprintf(stderr, "color_filters_init() failed %s\n", err_msg);
     g_free(err_msg);
  }

  /* Read the disabled protocols file. */
  read_disabled_protos_list(&gdp_path, &gdp_open_errno, &gdp_read_errno,
                            &dp_path, &dp_open_errno, &dp_read_errno);
  read_disabled_heur_dissector_list(&gdp_path, &gdp_open_errno, &gdp_read_errno,
                            &dp_path, &dp_open_errno, &dp_read_errno);
  if (gdp_path != NULL) {
    if (gdp_open_errno != 0) {
      cmdarg_err("Could not open global disabled protocols file\n\"%s\": %s.",
                 gdp_path, g_strerror(gdp_open_errno));
    }
    if (gdp_read_errno != 0) {
      cmdarg_err("I/O error reading global disabled protocols file\n\"%s\": %s.",
                 gdp_path, g_strerror(gdp_read_errno));
    }
    g_free(gdp_path);
  }
  if (dp_path != NULL) {
    if (dp_open_errno != 0) {
      cmdarg_err(
        "Could not open your disabled protocols file\n\"%s\": %s.", dp_path,
        g_strerror(dp_open_errno));
    }
    if (dp_read_errno != 0) {
      cmdarg_err(
        "I/O error reading your disabled protocols file\n\"%s\": %s.", dp_path,
        g_strerror(dp_read_errno));
    }
    g_free(dp_path);
  }

  cap_file_init(&cfile);

#ifdef HAVE_LIBPCAP
  if (!global_capture_opts.saving_to_file) {
    /* We're not saving the capture to a file; if "-q" wasn't specified,
       we should print packet information */
    if (!quiet)
      print_packet_info = TRUE;
  } else {
    /* We're saving to a file; if we're writing to the standard output.
       and we'll also be writing dissected packets to the standard
       output, reject the request.  At best, we could redirect that
       to the standard error; we *can't* write both to the standard
       output and have either of them be useful. */
    if (strcmp(global_capture_opts.save_file, "-") == 0 && print_packet_info) {
      cmdarg_err("You can't write both raw packet data and dissected packets"
          " to the standard output.");
      return 1;
    }
  }
#else
  /* We're not saving the capture to a file; if "-q" wasn't specified,
     we should print packet information */
  if (!quiet)
    print_packet_info = TRUE;
#endif

#ifdef _WIN32
  /* Start windows sockets */
  WSAStartup( MAKEWORD( 1, 1 ), &wsaData );
#endif /* _WIN32 */

  /* Notify all registered modules that have had any of their preferences
     changed either from one of the preferences file or from the command
     line that their preferences have changed. */
  prefs_apply_all();

  /* At this point MATE will have registered its field array so we can
     have a tap filter with one of MATE's late-registered fields as part
     of the filter.  We can now process all the "-z" arguments. */
  start_requested_stats();

#ifdef HAVE_LIBPCAP
  /* We currently don't support taps, or printing dissected packets,
     if we're writing to a pipe. */
  if (global_capture_opts.saving_to_file &&
      global_capture_opts.output_to_pipe) {
    if (tap_listeners_require_dissection()) {
      cmdarg_err("Taps aren't supported when saving to a pipe.");
      return 1;
    }
    if (print_packet_info) {
      cmdarg_err("Printing dissected packets isn't supported when saving to a pipe.");
      return 1;
    }
  }
#endif

  /* disabled protocols as per configuration file */
  if (gdp_path == NULL && dp_path == NULL) {
    set_disabled_protos_list();
    set_disabled_heur_dissector_list();
  }

  /* Build the column format array */
  build_column_format_array(&cfile.cinfo, prefs_p->num_cols, TRUE);

#ifdef HAVE_LIBPCAP
  capture_opts_trim_snaplen(&global_capture_opts, MIN_PACKET_SIZE);
  capture_opts_trim_ring_num_files(&global_capture_opts);
#endif

  return sharkd_loop();
}

/*#define USE_BROKEN_G_MAIN_LOOP*/

#ifdef USE_BROKEN_G_MAIN_LOOP
  GMainLoop *loop;
#else
  gboolean loop_running = FALSE;
#endif
  guint32 packet_count = 0;


typedef struct pipe_input_tag {
  gint             source;
  gpointer         user_data;
  ws_process_id   *child_process;
  pipe_input_cb_t  input_cb;
  guint            pipe_input_id;
#ifdef _WIN32
  GMutex          *callback_running;
#endif
} pipe_input_t;

static pipe_input_t pipe_input;

#ifdef _WIN32
/* The timer has expired, see if there's stuff to read from the pipe,
   if so, do the callback */
static gint
pipe_timer_cb(gpointer data)
{
  HANDLE        handle;
  DWORD         avail        = 0;
  gboolean      result;
  DWORD         childstatus;
  pipe_input_t *pipe_input_p = data;
  gint          iterations   = 0;

  g_mutex_lock (pipe_input_p->callback_running);

  /* try to read data from the pipe only 5 times, to avoid blocking */
  while(iterations < 5) {
    /*g_log(NULL, G_LOG_LEVEL_DEBUG, "pipe_timer_cb: new iteration");*/

    /* Oddly enough although Named pipes don't work on win9x,
       PeekNamedPipe does !!! */
    handle = (HANDLE) _get_osfhandle (pipe_input_p->source);
    result = PeekNamedPipe(handle, NULL, 0, NULL, &avail, NULL);

    /* Get the child process exit status */
    GetExitCodeProcess((HANDLE)*(pipe_input_p->child_process),
                       &childstatus);

    /* If the Peek returned an error, or there are bytes to be read
       or the childwatcher thread has terminated then call the normal
       callback */
    if (!result || avail > 0 || childstatus != STILL_ACTIVE) {

      /*g_log(NULL, G_LOG_LEVEL_DEBUG, "pipe_timer_cb: data avail");*/

      /* And call the real handler */
      if (!pipe_input_p->input_cb(pipe_input_p->source, pipe_input_p->user_data)) {
        g_log(NULL, G_LOG_LEVEL_DEBUG, "pipe_timer_cb: input pipe closed, iterations: %u", iterations);
        /* pipe closed, return false so that the timer is stopped */
        g_mutex_unlock (pipe_input_p->callback_running);
        return FALSE;
      }
    }
    else {
      /*g_log(NULL, G_LOG_LEVEL_DEBUG, "pipe_timer_cb: no data avail");*/
      /* No data, stop now */
      break;
    }

    iterations++;
  }

  /*g_log(NULL, G_LOG_LEVEL_DEBUG, "pipe_timer_cb: finished with iterations: %u, new timer", iterations);*/

  g_mutex_unlock (pipe_input_p->callback_running);

  /* we didn't stopped the timer, so let it run */
  return TRUE;
}
#endif


void
pipe_input_set_handler(gint source, gpointer user_data, ws_process_id *child_process, pipe_input_cb_t input_cb)
{

  pipe_input.source         = source;
  pipe_input.child_process  = child_process;
  pipe_input.user_data      = user_data;
  pipe_input.input_cb       = input_cb;

#ifdef _WIN32
#if GLIB_CHECK_VERSION(2,31,0)
  pipe_input.callback_running = g_malloc(sizeof(GMutex));
  g_mutex_init(pipe_input.callback_running);
#else
  pipe_input.callback_running = g_mutex_new();
#endif
  /* Tricky to use pipes in win9x, as no concept of wait.  NT can
     do this but that doesn't cover all win32 platforms.  GTK can do
     this but doesn't seem to work over processes.  Attempt to do
     something similar here, start a timer and check for data on every
     timeout. */
  /*g_log(NULL, G_LOG_LEVEL_DEBUG, "pipe_input_set_handler: new");*/
  pipe_input.pipe_input_id = g_timeout_add(200, pipe_timer_cb, &pipe_input);
#endif
}

static const nstime_t *
tshark_get_frame_ts(void *data, guint32 frame_num)
{
  capture_file *cf = (capture_file *) data;

  if (ref && ref->num == frame_num)
    return &ref->abs_ts;

  if (prev_dis && prev_dis->num == frame_num)
    return &prev_dis->abs_ts;

  if (prev_cap && prev_cap->num == frame_num)
    return &prev_cap->abs_ts;

  if (cf->frames) {
     frame_data *fd = frame_data_sequence_find(cf->frames, frame_num);

     return (fd) ? &fd->abs_ts : NULL;
  }

  return NULL;
}

static epan_t *
tshark_epan_new(capture_file *cf)
{
  epan_t *epan = epan_new();

  epan->data = cf;
  epan->get_frame_ts = tshark_get_frame_ts;
  epan->get_interface_name = cap_file_get_interface_name;
  epan->get_user_comment = NULL;

  return epan;
}

#ifdef HAVE_LIBPCAP

/* capture child detected an error */
void
capture_input_error_message(capture_session *cap_session _U_, char *error_msg, char *secondary_error_msg)
{
  cmdarg_err("%s", error_msg);
  cmdarg_err_cont("%s", secondary_error_msg);
}


/* capture child detected an capture filter related error */
void
capture_input_cfilter_error_message(capture_session *cap_session, guint i, char *error_message)
{
  capture_options *capture_opts = cap_session->capture_opts;
  dfilter_t         *rfcode = NULL;
  interface_options  interface_opts;

  g_assert(i < capture_opts->ifaces->len);
  interface_opts = g_array_index(capture_opts->ifaces, interface_options, i);

  if (dfilter_compile(interface_opts.cfilter, &rfcode, NULL) && rfcode != NULL) {
    cmdarg_err(
      "Invalid capture filter \"%s\" for interface '%s'.\n"
      "\n"
      "That string looks like a valid display filter; however, it isn't a valid\n"
      "capture filter (%s).\n"
      "\n"
      "Note that display filters and capture filters don't have the same syntax,\n"
      "so you can't use most display filter expressions as capture filters.\n"
      "\n"
      "See the User's Guide for a description of the capture filter syntax.",
      interface_opts.cfilter, interface_opts.descr, error_message);
    dfilter_free(rfcode);
  } else {
    cmdarg_err(
      "Invalid capture filter \"%s\" for interface '%s'.\n"
      "\n"
      "That string isn't a valid capture filter (%s).\n"
      "See the User's Guide for a description of the capture filter syntax.",
      interface_opts.cfilter, interface_opts.descr, error_message);
  }
}


/* capture child tells us we have a new (or the first) capture file */
gboolean
capture_input_new_file(capture_session *cap_session, gchar *new_file)
{
  capture_options *capture_opts = cap_session->capture_opts;
  capture_file *cf = (capture_file *) cap_session->cf;
  gboolean is_tempfile;
  int      err;

  if (cap_session->state == CAPTURE_PREPARING) {
    g_log(LOG_DOMAIN_CAPTURE, G_LOG_LEVEL_MESSAGE, "Capture started.");
  }
  g_log(LOG_DOMAIN_CAPTURE, G_LOG_LEVEL_MESSAGE, "File: \"%s\"", new_file);

  g_assert(cap_session->state == CAPTURE_PREPARING || cap_session->state == CAPTURE_RUNNING);

  /* free the old filename */
  if (capture_opts->save_file != NULL) {

    /* we start a new capture file, close the old one (if we had one before) */
    if (cf->state != FILE_CLOSED) {
      if (cf->wth != NULL) {
        wtap_close(cf->wth);
        cf->wth = NULL;
      }
      cf->state = FILE_CLOSED;
    }

    g_free(capture_opts->save_file);
    is_tempfile = FALSE;

    epan_free(cf->epan);
    cf->epan = tshark_epan_new(cf);
  } else {
    /* we didn't had a save_file before, must be a tempfile */
    is_tempfile = TRUE;
  }

  /* save the new filename */
  capture_opts->save_file = g_strdup(new_file);

  /* if we are in real-time mode, open the new file now */
  if (do_dissection) {
    /* this is probably unecessary, but better safe than sorry */
    ((capture_file *)cap_session->cf)->open_type = WTAP_TYPE_AUTO;
    /* Attempt to open the capture file and set up to read from it. */
    switch(cf_open((capture_file *)cap_session->cf, capture_opts->save_file, WTAP_TYPE_AUTO, is_tempfile, &err)) {
    case CF_OK:
      break;
    case CF_ERROR:
      /* Don't unlink (delete) the save file - leave it around,
         for debugging purposes. */
      g_free(capture_opts->save_file);
      capture_opts->save_file = NULL;
      return FALSE;
    }
  }

  cap_session->state = CAPTURE_RUNNING;

  return TRUE;
}


/* capture child tells us we have new packets to read */
void
capture_input_new_packets(capture_session *cap_session _U_, int to_read _U_)
{
#ifdef SIGINFO
  /*
   * Prevent a SIGINFO handler from writing to the standard error while
   * we're doing so or writing to the standard output; instead, have it
   * just set a flag telling us to print that information when we're done.
   */
  infodelay = TRUE;
#endif /* SIGINFO */

  /* TODO */

  if (print_packet_counts) {
      /* We're printing packet counts. */
      if (packet_count != 0) {
        fprintf(stderr, "\r%u ", packet_count);
        /* stderr could be line buffered */
        fflush(stderr);
      }
  }

#ifdef SIGINFO
  /*
   * Allow SIGINFO handlers to write.
   */
  infodelay = FALSE;

  /*
   * If a SIGINFO handler asked us to write out capture counts, do so.
   */
  if (infoprint)
    report_counts();
#endif /* SIGINFO */
}

static void
report_counts(void)
{
  if ((print_packet_counts == FALSE) && (really_quiet == FALSE)) {
    /* Report the count only if we aren't printing a packet count
       as packets arrive. */
      fprintf(stderr, "%u packet%s captured\n", packet_count,
            plurality(packet_count, "", "s"));
  }
#ifdef SIGINFO
  infoprint = FALSE; /* we just reported it */
#endif /* SIGINFO */
}

#ifdef SIGINFO
static void
report_counts_siginfo(int signum _U_)
{
  int sav_errno = errno;
  /* If we've been told to delay printing, just set a flag asking
     that we print counts (if we're supposed to), otherwise print
     the count of packets captured (if we're supposed to). */
  if (infodelay)
    infoprint = TRUE;
  else
    report_counts();
  errno = sav_errno;
}
#endif /* SIGINFO */


/* capture child detected any packet drops? */
void
capture_input_drops(capture_session *cap_session _U_, guint32 dropped)
{
  if (print_packet_counts) {
    /* We're printing packet counts to stderr.
       Send a newline so that we move to the line after the packet count. */
    fprintf(stderr, "\n");
  }

  if (dropped != 0) {
    /* We're printing packet counts to stderr.
       Send a newline so that we move to the line after the packet count. */
    fprintf(stderr, "%u packet%s dropped\n", dropped, plurality(dropped, "", "s"));
  }
}


/*
 * Capture child closed its side of the pipe, report any error and
 * do the required cleanup.
 */
void
capture_input_closed(capture_session *cap_session, gchar *msg)
{
  capture_file *cf = (capture_file *) cap_session->cf;

  if (msg != NULL)
    fprintf(stderr, "tshark: %s\n", msg);

  report_counts();

  if (cf != NULL && cf->wth != NULL) {
    wtap_close(cf->wth);
    if (cf->is_tempfile) {
      ws_unlink(cf->filename);
    }
  }
#ifdef USE_BROKEN_G_MAIN_LOOP
  /*g_main_loop_quit(loop);*/
  g_main_loop_quit(loop);
#else
  loop_running = FALSE;
#endif
}

#endif /* HAVE_LIBPCAP */

static gboolean
process_packet_first_pass(capture_file *cf, epan_dissect_t *edt,
               gint64 offset, struct wtap_pkthdr *whdr,
               const guchar *pd)
{
  frame_data     fdlocal;
  guint32        framenum;
  gboolean       passed;

  /* The frame number of this packet is one more than the count of
     frames in this packet. */
  framenum = cf->count + 1;

  /* If we're not running a display filter and we're not printing any
     packet information, we don't need to do a dissection. This means
     that all packets can be marked as 'passed'. */
  passed = TRUE;

  frame_data_init(&fdlocal, framenum, whdr, offset, cum_bytes);

  /* If we're going to print packet information, or we're going to
     run a read filter, or display filter, or we're going to process taps, set up to
     do a dissection and do so. */
  if (edt) {
    if (gbl_resolv_flags.mac_name || gbl_resolv_flags.network_name ||
        gbl_resolv_flags.transport_name)
      /* Grab any resolved addresses */
      host_name_lookup_process();

    /* If we're running a read filter, prime the epan_dissect_t with that
       filter. */
    if (cf->rfcode)
      epan_dissect_prime_dfilter(edt, cf->rfcode);

    if (cf->dfcode)
      epan_dissect_prime_dfilter(edt, cf->dfcode);

    frame_data_set_before_dissect(&fdlocal, &cf->elapsed_time,
                                  &ref, prev_dis);
    if (ref == &fdlocal) {
      ref_frame = fdlocal;
      ref = &ref_frame;
    }

    epan_dissect_run(edt, cf->cd_t, whdr, frame_tvbuff_new(&fdlocal, pd), &fdlocal, NULL);

    /* Run the read filter if we have one. */
    if (cf->rfcode)
      passed = dfilter_apply_edt(cf->rfcode, edt);
  }

  if (passed) {
    frame_data_set_after_dissect(&fdlocal, &cum_bytes);
    prev_cap = prev_dis = frame_data_sequence_add(cf->frames, &fdlocal);

    /* If we're not doing dissection then there won't be any dependent frames.
     * More importantly, edt.pi.dependent_frames won't be initialized because
     * epan hasn't been initialized.
     * if we *are* doing dissection, then mark the dependent frames, but only
     * if a display filter was given and it matches this packet.
     */
    if (edt && cf->dfcode) {
      if (dfilter_apply_edt(cf->dfcode, edt)) {
        g_slist_foreach(edt->pi.dependent_frames, find_and_mark_frame_depended_upon, cf->frames);
      }
    }

    cf->count++;
  } else {
    /* if we don't add it to the frame_data_sequence, clean it up right now
     * to avoid leaks */
    frame_data_destroy(&fdlocal);
  }

  if (edt)
    epan_dissect_reset(edt);

  return passed;
}


static int
load_cap_file(capture_file *cf, int max_packet_count, gint64 max_byte_count)
{
  int          err;
  gchar       *err_info = NULL;
  gint64       data_offset;
  struct wtap_pkthdr phdr;
  Buffer       buf;
  epan_dissect_t *edt = NULL;

  wtap_phdr_init(&phdr);

  {
    tshark_debug("tshark: perform_two_pass_analysis, do_dissection=%s", do_dissection ? "TRUE" : "FALSE");

    /* Allocate a frame_data_sequence for all the frames. */
    cf->frames = new_frame_data_sequence();

    if (do_dissection) {
       gboolean create_proto_tree = FALSE;

      /* If we're going to be applying a filter, we'll need to
         create a protocol tree against which to apply the filter. */
      if (cf->rfcode || cf->dfcode)
        create_proto_tree = TRUE;

      tshark_debug("tshark: create_proto_tree = %s", create_proto_tree ? "TRUE" : "FALSE");

      /* We're not going to display the protocol tree on this pass,
         so it's not going to be "visible". */
      edt = epan_dissect_new(cf->epan, create_proto_tree, FALSE);
    }

    tshark_debug("tshark: reading records for first pass");
    while (wtap_read(cf->wth, &err, &err_info, &data_offset)) {
      if (process_packet_first_pass(cf, edt, data_offset, wtap_phdr(cf->wth),
                         wtap_buf_ptr(cf->wth))) {
        /* Stop reading if we have the maximum number of packets;
         * When the -c option has not been used, max_packet_count
         * starts at 0, which practically means, never stop reading.
         * (unless we roll over max_packet_count ?)
         */
        if ( (--max_packet_count == 0) || (max_byte_count != 0 && data_offset >= max_byte_count)) {
          tshark_debug("tshark: max_packet_count (%d) or max_byte_count (%" G_GINT64_MODIFIER "d/%" G_GINT64_MODIFIER "d) reached",
                        max_packet_count, data_offset, max_byte_count);
          err = 0; /* This is not an error */
          break;
        }
      }
    }

    if (edt) {
      epan_dissect_free(edt);
      edt = NULL;
    }

    /* Close the sequential I/O side, to free up memory it requires. */
    wtap_sequential_close(cf->wth);

    /* Allow the protocol dissectors to free up memory that they
     * don't need after the sequential run-through of the packets. */
    postseq_cleanup_all_protocols();

    prev_dis = NULL;
    prev_cap = NULL;
    ws_buffer_init(&buf, 1500);

    tshark_debug("tshark: done with first pass");
  }

  wtap_phdr_cleanup(&phdr);

  if (err != 0) {
    tshark_debug("tshark: something failed along the line (%d)", err);

    switch (err) {

    case WTAP_ERR_UNSUPPORTED:
      cmdarg_err("The file \"%s\" contains record data that TShark doesn't support.\n(%s)",
                 cf->filename,
                 err_info != NULL ? err_info : "no information supplied");
      g_free(err_info);
      break;

    case WTAP_ERR_SHORT_READ:
      cmdarg_err("The file \"%s\" appears to have been cut short in the middle of a packet.",
                 cf->filename);
      break;

    case WTAP_ERR_BAD_FILE:
      cmdarg_err("The file \"%s\" appears to be damaged or corrupt.\n(%s)",
                 cf->filename,
                 err_info != NULL ? err_info : "no information supplied");
      g_free(err_info);
      break;

    case WTAP_ERR_DECOMPRESS:
      cmdarg_err("The compressed file \"%s\" appears to be damaged or corrupt.\n"
                 "(%s)", cf->filename,
                 err_info != NULL ? err_info : "no information supplied");
      g_free(err_info);
      break;

    default:
      cmdarg_err("An error occurred while reading the file \"%s\": %s.",
                 cf->filename, wtap_strerror(err));
      break;
    }
  }

  return err;
}

cf_status_t
cf_open(capture_file *cf, const char *fname, unsigned int type, gboolean is_tempfile, int *err)
{
  wtap  *wth;
  gchar *err_info;
  char   err_msg[2048+1];

  wth = wtap_open_offline(fname, type, err, &err_info, TRUE);
  if (wth == NULL)
    goto fail;

  /* The open succeeded.  Fill in the information for this file. */

  /* Create new epan session for dissection. */
  epan_free(cf->epan);
  cf->epan = tshark_epan_new(cf);

  cf->wth = wth;
  cf->f_datalen = 0; /* not used, but set it anyway */

  /* Set the file name because we need it to set the follow stream filter.
     XXX - is that still true?  We need it for other reasons, though,
     in any case. */
  cf->filename = g_strdup(fname);

  /* Indicate whether it's a permanent or temporary file. */
  cf->is_tempfile = is_tempfile;

  /* No user changes yet. */
  cf->unsaved_changes = FALSE;

  cf->cd_t      = wtap_file_type_subtype(cf->wth);
  cf->open_type = type;
  cf->count     = 0;
  cf->drops_known = FALSE;
  cf->drops     = 0;
  cf->snap      = wtap_snapshot_length(cf->wth);
  if (cf->snap == 0) {
    /* Snapshot length not known. */
    cf->has_snap = FALSE;
    cf->snap = WTAP_MAX_PACKET_SIZE;
  } else
    cf->has_snap = TRUE;
  nstime_set_zero(&cf->elapsed_time);
  ref = NULL;
  prev_dis = NULL;
  prev_cap = NULL;

  cf->state = FILE_READ_IN_PROGRESS;

  wtap_set_cb_new_ipv4(cf->wth, add_ipv4_name);
  wtap_set_cb_new_ipv6(cf->wth, (wtap_new_ipv6_callback_t) add_ipv6_name);

  return CF_OK;

fail:
  g_snprintf(err_msg, sizeof err_msg,
             cf_open_error_message(*err, err_info, FALSE, cf->cd_t), fname);
  cmdarg_err("%s", err_msg);
  return CF_ERROR;
}

static const char *
cf_open_error_message(int err, gchar *err_info, gboolean for_writing,
                      int file_type)
{
  const char *errmsg;
  static char errmsg_errno[1024+1];

  if (err < 0) {
    /* Wiretap error. */
    switch (err) {

    case WTAP_ERR_NOT_REGULAR_FILE:
      errmsg = "The file \"%s\" is a \"special file\" or socket or other non-regular file.";
      break;

    case WTAP_ERR_RANDOM_OPEN_PIPE:
      /* Seen only when opening a capture file for reading. */
      errmsg = "The file \"%s\" is a pipe or FIFO; TShark can't read pipe or FIFO files in two-pass mode.";
      break;

    case WTAP_ERR_FILE_UNKNOWN_FORMAT:
      /* Seen only when opening a capture file for reading. */
      errmsg = "The file \"%s\" isn't a capture file in a format TShark understands.";
      break;

    case WTAP_ERR_UNSUPPORTED:
      /* Seen only when opening a capture file for reading. */
      g_snprintf(errmsg_errno, sizeof(errmsg_errno),
                 "The file \"%%s\" contains record data that TShark doesn't support.\n"
                 "(%s)",
                 err_info != NULL ? err_info : "no information supplied");
      g_free(err_info);
      errmsg = errmsg_errno;
      break;

    case WTAP_ERR_CANT_WRITE_TO_PIPE:
      /* Seen only when opening a capture file for writing. */
      g_snprintf(errmsg_errno, sizeof(errmsg_errno),
                 "The file \"%%s\" is a pipe, and \"%s\" capture files can't be "
                 "written to a pipe.", wtap_file_type_subtype_short_string(file_type));
      errmsg = errmsg_errno;
      break;

    case WTAP_ERR_UNWRITABLE_FILE_TYPE:
      /* Seen only when opening a capture file for writing. */
      errmsg = "TShark doesn't support writing capture files in that format.";
      break;

    case WTAP_ERR_UNWRITABLE_ENCAP:
      /* Seen only when opening a capture file for writing. */
      g_snprintf(errmsg_errno, sizeof(errmsg_errno),
                 "TShark can't save this capture as a \"%s\" file.",
                 wtap_file_type_subtype_short_string(file_type));
      errmsg = errmsg_errno;
      break;

    case WTAP_ERR_ENCAP_PER_PACKET_UNSUPPORTED:
      if (for_writing) {
        g_snprintf(errmsg_errno, sizeof(errmsg_errno),
                   "TShark can't save this capture as a \"%s\" file.",
                   wtap_file_type_subtype_short_string(file_type));
        errmsg = errmsg_errno;
      } else
        errmsg = "The file \"%s\" is a capture for a network type that TShark doesn't support.";
      break;

    case WTAP_ERR_BAD_FILE:
      /* Seen only when opening a capture file for reading. */
      g_snprintf(errmsg_errno, sizeof(errmsg_errno),
                 "The file \"%%s\" appears to be damaged or corrupt.\n"
                 "(%s)",
                 err_info != NULL ? err_info : "no information supplied");
      g_free(err_info);
      errmsg = errmsg_errno;
      break;

    case WTAP_ERR_CANT_OPEN:
      if (for_writing)
        errmsg = "The file \"%s\" could not be created for some unknown reason.";
      else
        errmsg = "The file \"%s\" could not be opened for some unknown reason.";
      break;

    case WTAP_ERR_SHORT_READ:
      errmsg = "The file \"%s\" appears to have been cut short"
               " in the middle of a packet or other data.";
      break;

    case WTAP_ERR_SHORT_WRITE:
      errmsg = "A full header couldn't be written to the file \"%s\".";
      break;

    case WTAP_ERR_COMPRESSION_NOT_SUPPORTED:
      errmsg = "This file type cannot be written as a compressed file.";
      break;

    case WTAP_ERR_DECOMPRESS:
      /* Seen only when opening a capture file for reading. */
      g_snprintf(errmsg_errno, sizeof(errmsg_errno),
                 "The compressed file \"%%s\" appears to be damaged or corrupt.\n"
                 "(%s)",
                 err_info != NULL ? err_info : "no information supplied");
      g_free(err_info);
      errmsg = errmsg_errno;
      break;

    default:
      g_snprintf(errmsg_errno, sizeof(errmsg_errno),
                 "The file \"%%s\" could not be %s: %s.",
                 for_writing ? "created" : "opened",
                 wtap_strerror(err));
      errmsg = errmsg_errno;
      break;
    }
  } else
    errmsg = file_open_error_message(err, for_writing);
  return errmsg;
}

/*
 * Open/create errors are reported with an console message in TShark.
 */
static void
open_failure_message(const char *filename, int err, gboolean for_writing)
{
  fprintf(stderr, "tshark: ");
  fprintf(stderr, file_open_error_message(err, for_writing), filename);
  fprintf(stderr, "\n");
}

/*
 * General errors are reported with an console message in TShark.
 */
static void
failure_message(const char *msg_format, va_list ap)
{
  fprintf(stderr, "tshark: ");
  vfprintf(stderr, msg_format, ap);
  fprintf(stderr, "\n");
}

/*
 * Read errors are reported with an console message in TShark.
 */
static void
read_failure_message(const char *filename, int err)
{
  cmdarg_err("An error occurred while reading from the file \"%s\": %s.",
          filename, g_strerror(err));
}

/*
 * Write errors are reported with an console message in TShark.
 */
static void
write_failure_message(const char *filename, int err)
{
  cmdarg_err("An error occurred while writing to the file \"%s\": %s.",
          filename, g_strerror(err));
}

/*
 * Report additional information for an error in command-line arguments.
 */
static void
failure_message_cont(const char *msg_format, va_list ap)
{
  vfprintf(stderr, msg_format, ap);
  fprintf(stderr, "\n");
}

cf_status_t
sharkd_cf_open(const char *fname, unsigned int type, gboolean is_tempfile, int *err)
{
	return cf_open(&cfile, fname, type, is_tempfile, err);
}

int
sharkd_load_cap_file(void)
{
	return load_cap_file(&cfile, 0, 0);
}

int
sharkd_dissect_request(int framenum, void (*cb)(packet_info *, proto_tree *, struct epan_column_info *, GSList *, void *), int dissect_bytes, int dissect_columns, int dissect_tree, void *data)
{
	frame_data *fdata;
	column_info *cinfo = (dissect_columns) ? &cfile.cinfo : NULL;
	epan_dissect_t edt;
	gboolean create_proto_tree;
	struct wtap_pkthdr phdr; /* Packet header */
	Buffer buf; /* Packet data */

	int err;
	char *err_info = NULL;

	fdata = frame_data_sequence_find(cfile.frames, framenum);
	if (fdata == NULL)
		return -1;

	wtap_phdr_init(&phdr);
	ws_buffer_init(&buf, 1500);

	if (!wtap_seek_read(cfile.wth, fdata->file_off, &phdr, &buf, &err, &err_info)) {
		ws_buffer_free(&buf);
		return -1;	/* error reading the record */
	}

	create_proto_tree = (dissect_tree) || (cinfo && have_custom_cols(cinfo));
	epan_dissect_init(&edt, cfile.epan, create_proto_tree, dissect_tree);

	if (cinfo)
		col_custom_prime_edt(&edt, cinfo);

	/*
	 * XXX - need to catch an OutOfMemoryError exception and
	 * attempt to recover from it.
	 */
	epan_dissect_run(&edt, cfile.cd_t, &phdr, frame_tvbuff_new_buffer(fdata, &buf), fdata, cinfo);

	if (cinfo) {
		/* "Stringify" non frame_data vals */
		epan_dissect_fill_in_columns(&edt, FALSE, TRUE/* fill_fd_columns */);
	}

	cb(&edt.pi, dissect_tree ? edt.tree : NULL, cinfo, dissect_bytes ? edt.pi.data_src : NULL, data);

	epan_dissect_cleanup(&edt);
	wtap_phdr_cleanup(&phdr);
	ws_buffer_free(&buf);
	return 0;
}

/* based on packet_list_dissect_and_cache_record */
int
sharkd_dissect_columns(int framenum, column_info *cinfo, gboolean dissect_color)
{
	frame_data *fdata;
	epan_dissect_t edt;
	gboolean create_proto_tree;
	struct wtap_pkthdr phdr; /* Packet header */
	Buffer buf; /* Packet data */

	int err;
	char *err_info = NULL;

	fdata = frame_data_sequence_find(cfile.frames, framenum);
	if (fdata == NULL) {
		col_fill_in_error(cinfo, fdata, FALSE, TRUE/* fill_fd_columns */);
		return -1;	/* error reading the record */
	}

	wtap_phdr_init(&phdr);
	ws_buffer_init(&buf, 1500);

	if (!wtap_seek_read(cfile.wth, fdata->file_off, &phdr, &buf, &err, &err_info)) {
		col_fill_in_error(cinfo, fdata, FALSE, FALSE /* fill_fd_columns */);
		ws_buffer_free(&buf);
		return -1;	/* error reading the record */
	}

	create_proto_tree = (dissect_color && color_filters_used()) ||
						(cinfo && have_custom_cols(cinfo));

	epan_dissect_init(&edt, cfile.epan,
					  create_proto_tree,
					  FALSE /* proto_tree_visible */);

	if (dissect_color) {
		color_filters_prime_edt(&edt);
		fdata->flags.need_colorize = 1;
	}

	if (cinfo)
		col_custom_prime_edt(&edt, cinfo);

	/*
	 * XXX - need to catch an OutOfMemoryError exception and
	 * attempt to recover from it.
	 */
	epan_dissect_run(&edt, cfile.cd_t, &phdr, frame_tvbuff_new_buffer(fdata, &buf), fdata, cinfo);

	if (cinfo) {
		/* "Stringify" non frame_data vals */
		epan_dissect_fill_in_columns(&edt, FALSE, TRUE/* fill_fd_columns */);
	}

	epan_dissect_cleanup(&edt);
	wtap_phdr_cleanup(&phdr);
	ws_buffer_free(&buf);
	return 0;
}

int
sharkd_retap(void)
{
  guint32          framenum;
  frame_data      *fdata;
  Buffer           buf;
  struct wtap_pkthdr phdr;
  int err;
  char *err_info = NULL;

  gboolean      filtering_tap_listeners;
  guint         tap_flags;
  gboolean      construct_protocol_tree;
  epan_dissect_t edt;
  column_info   *cinfo;

  filtering_tap_listeners = have_filtering_tap_listeners();
  tap_flags = union_of_tap_listener_flags();

  construct_protocol_tree = filtering_tap_listeners || (tap_flags & TL_REQUIRES_PROTO_TREE);
  cinfo = (tap_flags & TL_REQUIRES_COLUMNS) ? &cfile.cinfo : NULL;

  wtap_phdr_init(&phdr);
  ws_buffer_init(&buf, 1500);
  epan_dissect_init(&edt, cfile.epan, construct_protocol_tree, FALSE);

  reset_tap_listeners();

  for (framenum = 1; framenum <= cfile.count; framenum++) {
    fdata = frame_data_sequence_find(cfile.frames, framenum);

    if (!wtap_seek_read(cfile.wth, fdata->file_off, &phdr, &buf, &err, &err_info))
      break;

    epan_dissect_run_with_taps(&edt, cfile.cd_t, &phdr, frame_tvbuff_new(fdata, ws_buffer_start_ptr(&buf)), fdata, cinfo);
    epan_dissect_reset(&edt);
  }

  wtap_phdr_cleanup(&phdr);
  ws_buffer_free(&buf);
  epan_dissect_cleanup(&edt);

  draw_tap_listeners(TRUE);

  return 0;
}

int
sharkd_filter(const char *dftext, guint8 **result)
{
  dfilter_t  *dfcode = NULL;

  guint32 framenum;
  guint32 frames_count;
  Buffer buf;
  struct wtap_pkthdr phdr;
  int err;
  char *err_info = NULL;

  guint8 *result_bits;
  guint8  passed_bits;

  epan_dissect_t edt;

  if (!dfilter_compile(dftext, &dfcode, &err_info)) {
    g_free(err_info);
    return -1;
  }

  frames_count = cfile.count;

  wtap_phdr_init(&phdr);
  ws_buffer_init(&buf, 1500);
  epan_dissect_init(&edt, cfile.epan, TRUE, FALSE);

  passed_bits = 0;
  result_bits = (guint8 *) g_malloc(2 + (frames_count / 8));

  for (framenum = 1; framenum <= frames_count; framenum++) {
    frame_data *fdata = frame_data_sequence_find(cfile.frames, framenum);

    if ((framenum & 7) == 0) {
      result_bits[(framenum / 8) - 1] = passed_bits;
      passed_bits = 0;
    }

    if (!wtap_seek_read(cfile.wth, fdata->file_off, &phdr, &buf, &err, &err_info))
      break;

    /* frame_data_set_before_dissect */
    epan_dissect_prime_dfilter(&edt, dfcode);

    epan_dissect_run(&edt, cfile.cd_t, &phdr, frame_tvbuff_new_buffer(fdata, &buf), fdata, NULL);

    if (dfilter_apply_edt(dfcode, &edt))
      passed_bits |= (1 << (framenum % 8));

    /* if passed or ref -> frame_data_set_after_dissect */

    epan_dissect_reset(&edt);
  }

  if ((framenum & 7) == 0)
      framenum--;
  result_bits[framenum / 8] = passed_bits;

  wtap_phdr_cleanup(&phdr);
  ws_buffer_free(&buf);
  epan_dissect_cleanup(&edt);

  dfilter_free(dfcode);

  *result = result_bits;

  return framenum;
}

#include "version.h"
const char *sharkd_version(void)
{
	/* based on get_ws_vcs_version_info(), but shorter */
#ifdef VCSVERSION
	return VCSVERSION;
#else
	return VERSION;
#endif
}

/*
 * Editor modelines  -  https://www.wireshark.org/tools/modelines.html
 *
 * Local variables:
 * c-basic-offset: 2
 * tab-width: 8
 * indent-tabs-mode: nil
 * End:
 *
 * vi: set shiftwidth=2 tabstop=8 expandtab:
 * :indentSize=2:tabSize=8:noTabs=true:
 */
