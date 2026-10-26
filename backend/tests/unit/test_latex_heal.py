from learnharness.core.latex_heal import heal_latex


def test_collapses_doubled_commands_only():
    assert heal_latex(r"$q \\cdot k$ e $\\sqrt{d_k}$") == r"$q \cdot k$ e $\sqrt{d_k}$"
    # Real line breaks and single escapes stay untouched.
    assert heal_latex(r"$\begin{matrix} a \\ b \end{matrix}$") == r"$\begin{matrix} a \\ b \end{matrix}$"
    assert heal_latex(r"$\frac{1}{2}$") == r"$\frac{1}{2}$"
