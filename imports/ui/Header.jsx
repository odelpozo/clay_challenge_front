import React from "react";

const Header = () => {
  return (
    <nav>
      <div className="nav-wrapper">
        <a href="#" className="brand-logo">
          Internationalization Simulation - (i18n)
        </a>
        <a href="#" data-target="mobile-demo" className="sidenav-trigger">
          <i className="material-icons">menu</i>
        </a>
        <ul id="nav-mobile" className="right hide-on-med-and-down">
          <li>
            <a href="/">[VIEW FRONTEND]</a>
          </li>
          <li>
            <a href="/insert">[WORK BACKEND] </a>
          </li>
        </ul>
      </div>
    </nav>
  );
};

export default Header;
