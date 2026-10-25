/* 報名資料存取層（Supabase）
   - 報名頁：直接以 REST 新增一筆報名，訪客沒有讀取權限
   - 後台：用 supabase-js 登入，只有 admins 名單內的帳號能讀寫
   anon key 是公開金鑰，資料安全由資料庫的 RLS 權限規則保護 */
window.RegDB = (function () {
  var URL = 'https://zjtmshwfllmfwhcddkjx.supabase.co';
  var KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpqdG1zaHdmbGxtZndoY2Rka2p4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI4NjIxMTYsImV4cCI6MjEwODQzODExNn0.dCXdIH5Khg1_uCiFYW8eGTSECsJ90KT_Ty-91VEr2Uo';
  var sb = null;
  function client() {
    if (!sb) {
      if (!window.supabase) throw new Error('supabase-js not loaded');
      sb = window.supabase.createClient(URL, KEY);
    }
    return sb;
  }
  function ok(res) { if (res.error) throw res.error; return res.data }
  // 呼叫函式，失敗時把伺服器的中文錯誤訊息帶出來
  function callAdmins(body) {
    return client().functions.invoke('manage-admins', { body: body }).then(function (res) {
      if (!res.error) return res.data;
      var ctx = res.error.context;
      return (ctx && ctx.json ? ctx.json() : Promise.resolve({})).then(function (j) {
        throw new Error((j && j.error) || '操作失敗，請稍後再試');
      }, function () { throw new Error('操作失敗，請稍後再試') });
    });
  }

  return {
    mode: 'live',

    add: function (rec) {
      var row = {
        batch: rec.batch, name: rec.name, email: rec.email, phone: rec.phone, line: rec.line,
        school: rec.school, dept: rec.dept, channels: rec.channels, note: rec.note || '', ref: rec.ref || null
      };
      return fetch(URL + '/rest/v1/registrations', {
        method: 'POST',
        headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(row)
      }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); });
    },

    // 班級報名開關（訪客可讀，只有管理員可改）
    batches: function () {
      return fetch(URL + '/rest/v1/batches?select=name,open&order=sort', { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() });
    },
    setBatchOpen: function (name, open) {
      return client().from('batches').update({ open: open }).eq('name', name).select('name,open').then(ok).then(function (rows) {
        if (!rows || !rows.length) throw new Error('沒有權限');
        return rows[0];
      });
    },

    session: function () {
      return client().auth.getSession().then(function (res) {
        var s = res.data && res.data.session;
        if (!s) return '';
        return client().rpc('am_i_admin').then(function (r) { return r.data === true ? s.user.email : '' });
      });
    },
    signIn: function (email, pw) {
      var c = client();
      return c.auth.signInWithPassword({ email: email, password: pw }).then(ok).then(function (d) {
        return c.rpc('am_i_admin').then(function (r) {
          if (r.data !== true) return c.auth.signOut().then(function () { throw new Error('not admin') });
          return d.user.email;
        });
      });
    },
    signOut: function () { return client().auth.signOut() },

    list: function () {
      return client().from('registrations').select('*').order('created_at', { ascending: false }).then(ok);
    },
    remove: function (id) { return client().from('registrations').delete().eq('id', id).then(ok) },
    promoters: function () { return client().from('promoters').select('code,name').order('created_at').then(ok) },
    savePromoter: function (p) { return client().from('promoters').upsert({ code: p.code, name: p.name }).then(ok) },
    removePromoter: function (code) { return client().from('promoters').delete().eq('code', code).then(ok) },

    // 管理員：名單可直接讀；新增／移除經由 manage-admins 函式（需要伺服器端權限）
    admins: function () { return client().from('admins').select('email,created_at,notify').order('created_at').then(ok) },
    setAdminNotify: function (email, on) { return client().from('admins').update({ notify: on }).eq('email', email).then(ok) },
    addAdmin: function (email, password) { return callAdmins({ action: 'add', email: email, password: password }) },
    removeAdmin: function (email) { return callAdmins({ action: 'remove', email: email }) },
    // 忘記密碼：請伺服器寄出重設信（不論是否為管理員都回應相同結果）
    forgot: function (email) {
      return fetch(URL + '/functions/v1/notify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'forgot', email: email, page: location.origin + location.pathname })
      });
    },
    // 用信中的 token 換得登入狀態，再設定新密碼
    recover: function (tokenHash) {
      return client().auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' }).then(ok).then(function (d) { return d.user.email });
    },
    setNewPassword: function (pw) {
      var c = client();
      return c.auth.updateUser({ password: pw }).then(function (r) {
        if (r.error) throw new Error(/should be different/i.test(r.error.message) ? '新密碼不能和舊密碼相同' : '更新失敗：' + r.error.message);
        return c.rpc('am_i_admin').then(function (a) {
          if (a.data !== true) return c.auth.signOut().then(function () { throw new Error('此帳號沒有後台權限') });
          return r.data.user.email;
        });
      });
    },
    resetAdminPassword: function (email, password) { return callAdmins({ action: 'reset', email: email, password: password }) },
    // 先用目前密碼驗證身分，再更新為新密碼
    changePassword: function (email, current, pw) {
      var c = client();
      return c.auth.signInWithPassword({ email: email, password: current }).then(function (res) {
        if (res.error) throw new Error('目前密碼不正確');
        return c.auth.updateUser({ password: pw }).then(function (r) {
          if (r.error) throw new Error(/should be different/i.test(r.error.message) ? '新密碼不能和目前密碼相同' : '更新失敗：' + r.error.message);
        });
      });
    }
  };
})();
